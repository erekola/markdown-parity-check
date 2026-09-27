// HTML main-content extraction into the shared block model. Uses htmlparser2 (parsing) and css-select
// (selectors). No JavaScript is executed; dynamic pages are compared as served.

import { parseDocument } from 'htmlparser2';
import { selectAll, selectOne } from 'css-select';
import { Element, Text, type AnyNode, type ChildNode, type Document, type ParentNode } from 'domhandler';
import type { Block, Extraction, ExtractionIssue, Link, ListInfo } from './model.js';
import { extractNumbers, looseNormalize, normalizeCode, resolveHref, strictNormalize } from './normalize.js';

export interface HtmlExtractOptions {
  /** Opt-in component semantics. The default keeps generic HTML visibility rules. */
  profile?: 'generic' | 'starlight';
  /** User supplied CSS selector for the main content. */
  selector?: string;
  /** Base URL for resolving relative links; a <base href> in the document takes precedence. */
  baseUrl?: string | null;
  /** Deepest element nesting accepted, counted from the document root. Default MAX_NESTING_DEPTH. */
  maxDepth?: number;
}

export class HtmlExtractError extends Error {}

/** Default nesting limit for both extractors. The extraction walks the tree recursively, and a document
 * nested a few thousand levels deep exhausts the call stack (measured 2026-09-11: 5 000 nested div
 * elements under Node.js 24). Real pages stay far below this. */
export const MAX_NESTING_DEPTH = 1024;

/** Deepest element nesting under a node, counted with an explicit stack so the count itself cannot
 * exhaust the call stack. */
export function nestingDepth(node: ParentNode): number {
  let max = 0;
  const stack: Array<[ChildNode, number]> = node.children.map((c) => [c, 1]);
  while (stack.length > 0) {
    const [n, d] = stack.pop()!;
    if (!(n instanceof Element)) continue;
    if (d > max) max = d;
    for (const c of n.children) stack.push([c, d + 1]);
  }
  return max;
}

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'nav', 'iframe', 'svg', 'canvas', 'object', 'embed', 'map', 'form', 'button', 'input', 'select', 'textarea', 'dialog']);
const SKIP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar', 'dialog']);
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'summary', 'dd', 'dl', 'dt', 'div', 'fieldset', 'figcaption', 'figure', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'body', 'html', 'center', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'caption']);
const HEADING_RE = /^h([1-6])$/;

interface Ctx {
  profile: 'generic' | 'starlight';
  base: string | null;
  source: string;
  lineStarts: number[];
  blocks: Block[];
  notes: string[];
  root: Element;
  /** Nesting level added to every list inside a Starlight tab panel, because starlight-llms-txt nests the panel
   * content inside the tab's list item. */
  listBase: number;
  /** The item numbers of each numbered list, computed once per list. */
  ordinals: Map<Element, Map<Element, number>>;
  /** The path segment of each element, computed once per parent and tag name. */
  segments: Map<Element, string>;
}

function lineOf(ctx: Ctx, node: AnyNode): number | undefined {
  const idx = node.startIndex;
  if (idx === null || idx === undefined || idx < 0) return undefined;
  // Binary search over line start offsets.
  let lo = 0;
  let hi = ctx.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((ctx.lineStarts[mid] ?? 0) <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function pathOf(ctx: Ctx, el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur) {
    parts.unshift(segment(ctx, cur));
    if (cur === ctx.root) break;
    cur = cur.parent instanceof Element ? cur.parent : null;
  }
  return parts.join(' > ');
}

/**
 * The element's own part of a path: its tag name, with :nth-of-type(n) when the parent has more than one child of
 * that name. The positions of all same-named siblings are computed at once and kept in ctx. Up to 0.2.12 every
 * block counted its siblings again, so a list of 20 000 items took time quadratic in its length (found by an
 * independent review before 0.2.13 was released).
 */
function segment(ctx: Ctx, el: Element): string {
  const known = ctx.segments.get(el);
  if (known !== undefined) return known;
  const siblings = el.parent ? el.parent.children : [el];
  const same = siblings.filter((c): c is Element => c instanceof Element && c.name === el.name);
  same.forEach((c, i) => ctx.segments.set(c, same.length > 1 ? `${c.name}:nth-of-type(${i + 1})` : c.name));
  return ctx.segments.get(el) ?? el.name;
}

function hasClass(el: Element, name: string): boolean {
  return (el.attribs.class ?? '').split(/\s+/).includes(name);
}

function ancestor(el: Element, predicate: (node: Element) => boolean): Element | null {
  let parent = el.parent;
  while (parent instanceof Element) {
    if (predicate(parent)) return parent;
    parent = parent.parent;
  }
  return null;
}

/** The link starlight-llms-txt writes for an iframe. hast-util-to-mdast keeps an iframe only when it has both a
 * source and a title, as a link whose text is the title; any other iframe produces nothing. */
function iframeLink(el: Element): { src: string; title: string } | null {
  const src = el.attribs['src'] ?? '';
  const title = el.attribs['title'] ?? '';
  return src && title ? { src, title } : null;
}

/** The hidden and aria-hidden attributes alone, without the tag, role and page chrome rules of isSkipped. */
function hiddenAttr(el: Element): boolean {
  return el.attribs['hidden'] !== undefined || el.attribs['aria-hidden'] === 'true';
}

/**
 * Text of code as the page shows it: every text node with its whitespace, except under a hidden or aria-hidden
 * element. Up to 0.2.12 code used textContent, which also returns hidden descendants, so a hidden span inside a
 * code block counted as code while the same span in a paragraph did not (found by an outside review 2026-09-26).
 */
function visibleCode(nodes: ChildNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node instanceof Text) out += node.data;
    else if (node instanceof Element && !hiddenAttr(node)) out += visibleCode(node.children);
  }
  return out;
}

function isSkipped(el: Element, root: Element, profile: 'generic' | 'starlight' = 'generic', ignoreHidden = false): boolean {
  if (SKIP_TAGS.has(el.name) && !(profile === 'starlight' && el.name === 'iframe' && iframeLink(el))) return true;
  const role = (el.attribs['role'] ?? '').toLowerCase();
  if (SKIP_ROLES.has(role)) return true;
  if (el.attribs['hidden'] !== undefined && !ignoreHidden) return true;
  const asideTitle = profile === 'starlight' && el.name === 'p' && hasClass(el, 'starlight-aside__title')
    && el.parent instanceof Element && el.parent.name === 'aside' && hasClass(el.parent, 'starlight-aside');
  if (el.attribs['aria-hidden'] === 'true' && !asideTitle) return true;
  // Expressive Code's terminal-frame label is UI text, not source code or a filename.
  if (profile === 'starlight' && el.name === 'span' && hasClass(el, 'sr-only')
    && el.parent instanceof Element && el.parent.name === 'figcaption'
    && ancestor(el, (node) => hasClass(node, 'expressive-code'))) return true;
  // header/footer are page chrome only when they sit directly under body (or the html root), not inside an
  // article, where they usually carry metadata that belongs to the content.
  if ((el.name === 'header' || el.name === 'footer') && el.parent instanceof Element && (el.parent.name === 'body' || el.parent.name === 'html')) {
    return el !== root;
  }
  return false;
}

interface InlineRun {
  text: string;
  links: Link[];
  firstNode: AnyNode | null;
}

function newRun(): InlineRun {
  return { text: '', links: [], firstNode: null };
}

/** Collects inline text of a node, recording links. Block-level descendants are treated as inline here. */
function inlineText(ctx: Ctx, node: ChildNode, run: InlineRun): void {
  if (node instanceof Text) {
    if (run.firstNode === null && node.data.trim() !== '') run.firstNode = node;
    run.text += node.data;
    return;
  }
  if (!(node instanceof Element)) return;
  if (isSkipped(node, ctx.root, ctx.profile)) return;
  if (run.firstNode === null) run.firstNode = node;
  if (node.name === 'br') {
    run.text += ' ';
    return;
  }
  if (node.name === 'img') {
    const alt = node.attribs['alt'];
    if (alt && alt.trim()) run.text += ` ${alt} `;
    return;
  }
  if (ctx.profile === 'starlight' && node.name === 'iframe') {
    const link = iframeLink(node);
    if (link) {
      run.links.push({ text: strictNormalize(link.title), rawHref: link.src, resolved: resolveHref(link.src, ctx.base) });
      run.text += link.title;
    }
    return;
  }
  if (node.name === 'a' && node.attribs['href'] !== undefined) {
    const inner = newRun();
    for (const child of node.children) inlineText(ctx, child, inner);
    const raw = node.attribs['href'] ?? '';
    run.links.push({ text: strictNormalize(inner.text), rawHref: raw, resolved: resolveHref(raw, ctx.base) });
    run.links.push(...inner.links);
    run.text += inner.text;
    return;
  }
  if (BLOCK_TAGS.has(node.name)) run.text += ' ';
  for (const child of node.children) inlineText(ctx, child, run);
  if (BLOCK_TAGS.has(node.name)) run.text += ' ';
}

function pushBlock(ctx: Ctx, partial: Omit<Block, 'loose' | 'numbers' | 'location'>, node: AnyNode, pathEl: Element): void {
  const block: Block = {
    ...partial,
    loose: looseNormalize(partial.text),
    numbers: extractNumbers(partial.text),
    location: { line: lineOf(ctx, node), path: pathOf(ctx, pathEl), blockIndex: ctx.blocks.length },
  };
  ctx.blocks.push(block);
}

function flushRun(ctx: Ctx, run: InlineRun, container: Element, type: 'paragraph' | 'listItem' = 'paragraph', list?: ListInfo): void {
  const text = strictNormalize(run.text);
  if (text === '') return;
  const node = run.firstNode ?? container;
  pushBlock(ctx, { type, text, links: run.links, ...(type === 'listItem' && list ? { list } : {}) }, node, container);
}

function hasBlockChild(el: Element): boolean {
  return el.children.some((c) => c instanceof Element && BLOCK_TAGS.has(c.name) && !SKIP_TAGS.has(c.name));
}

function walk(ctx: Ctx, el: Element): void {
  // A container: inline runs between block children become paragraphs; block children recurse.
  let run = newRun();
  for (const child of el.children) {
    if (child instanceof Element && isSkipped(child, ctx.root, ctx.profile)) continue;
    if (child instanceof Element && (BLOCK_TAGS.has(child.name) || (ctx.profile === 'starlight' && child.name === 'starlight-tabs'))) {
      flushRun(ctx, run, el);
      run = newRun();
      handleBlock(ctx, child);
    } else {
      inlineText(ctx, child, run);
    }
  }
  flushRun(ctx, run, el);
}

function handleBlock(ctx: Ctx, el: Element): void {
  if (ctx.profile === 'starlight' && el.name === 'starlight-tabs') {
    handleStarlightTabs(ctx, el);
    return;
  }
  const m = HEADING_RE.exec(el.name);
  if (m) {
    const run = newRun();
    for (const c of el.children) inlineText(ctx, c, run);
    const text = strictNormalize(run.text);
    if (text !== '') pushBlock(ctx, { type: 'heading', text, depth: Number(m[1]), links: run.links }, el, el);
    return;
  }
  if (el.name === 'p' || el.name === 'dt' || el.name === 'dd' || el.name === 'figcaption' || el.name === 'summary' || el.name === 'caption' || el.name === 'address') {
    if (hasBlockChild(el)) {
      walk(ctx, el);
      return;
    }
    const run = newRun();
    for (const c of el.children) inlineText(ctx, c, run);
    flushRun(ctx, run, el);
    return;
  }
  if (el.name === 'pre') {
    const code = normalizeCode(ctx.profile === 'starlight' ? starlightCode(el) : visibleCode(el.children));
    if (code.trim() !== '') pushBlock(ctx, { type: 'code', text: strictNormalize(code), code, links: [] }, el, el);
    return;
  }
  if (el.name === 'table') {
    handleTable(ctx, el);
    return;
  }
  if (el.name === 'ul' || el.name === 'ol') {
    // A hidden item or list is skipped like any other hidden element (0.2.13; up to 0.2.12 it was read).
    for (const c of el.children) {
      if (!(c instanceof Element) || isSkipped(c, ctx.root, ctx.profile)) continue;
      if (c.name === 'li') handleListItem(ctx, c);
      else if (c.name === 'ul' || c.name === 'ol') handleBlock(ctx, c);
    }
    return;
  }
  if (el.name === 'li') {
    handleListItem(ctx, el);
    return;
  }
  if (el.name === 'hr') return;
  // Generic container (div, section, article, blockquote, figure, details, header, footer, ...).
  walk(ctx, el);
}

/**
 * Where an item sits in its list (0.2.13). Up to 0.2.12 a list item carried its text only, so a changed start
 * number, nesting level or task state passed unreported (found by an outside review 2026-09-26).
 */
function listInfo(ctx: Ctx, li: Element): ListInfo {
  const parent = li.parent instanceof Element ? li.parent : null;
  const ordered = parent?.name === 'ol';
  let lists = 0;
  for (let p: ParentNode | null = li.parent; p instanceof Element; p = p.parent) {
    if (p.name === 'ul' || p.name === 'ol') lists++;
    if (p === ctx.root) break;
  }
  const info: ListInfo = { ordered, depth: ctx.listBase + Math.max(0, lists - 1), checked: taskState(li) };
  if (ordered && parent) {
    const ordinal = listOrdinals(ctx, parent).get(li);
    if (ordinal !== undefined) info.ordinal = ordinal;
  }
  return info;
}

/**
 * The numbers the visible items of a numbered list show, the way a browser's list counter counts them: from the
 * list's start, or from the item count for a reversed list without one, and an item's value attribute sets the
 * number from that item on. One pass per list, kept in ctx; the first version counted again for every item, and
 * a list of 20 000 items took ten seconds (found by an independent review before 0.2.13 was released). A reversed
 * list gives only its first item a number: Markdown has no reversed list and numbers every item from the first,
 * so the later numbers of a faithful Markdown copy can never match.
 */
function listOrdinals(ctx: Ctx, ol: Element): Map<Element, number> {
  const cached = ctx.ordinals.get(ol);
  if (cached) return cached;
  const out = new Map<Element, number>();
  const items = ol.children.filter((c): c is Element => c instanceof Element && c.name === 'li' && !isSkipped(c, ctx.root, ctx.profile));
  const reversed = ol.attribs['reversed'] !== undefined;
  const start = Number.parseInt(ol.attribs['start'] ?? '', 10);
  let n = Number.isFinite(start) ? start : reversed ? items.length : 1;
  items.forEach((item, i) => {
    const value = Number.parseInt(item.attribs['value'] ?? '', 10);
    if (Number.isFinite(value)) n = value;
    if (!reversed || i === 0) out.set(item, n);
    n += reversed ? -1 : 1;
  });
  ctx.ordinals.set(ol, out);
  return out;
}

/** The state of the item's own checkbox, not one inside a nested list: true, false, or null without one. */
function taskState(li: Element): boolean | null {
  const stack: ChildNode[] = [...li.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!(node instanceof Element) || node.name === 'ul' || node.name === 'ol') continue;
    if (node.name === 'input' && (node.attribs['type'] ?? '').toLowerCase() === 'checkbox') return node.attribs['checked'] !== undefined;
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return null;
}

function handleListItem(ctx: Ctx, li: Element): void {
  // The item's own inline text (and inline text of a leading <p>) becomes one listItem block; nested lists
  // and other block children recurse.
  const info = listInfo(ctx, li);
  let run = newRun();
  let ownFlushed = false;
  for (const child of li.children) {
    if (child instanceof Element && isSkipped(child, ctx.root, ctx.profile)) continue;
    if (child instanceof Element && (BLOCK_TAGS.has(child.name) || (ctx.profile === 'starlight' && child.name === 'starlight-tabs'))) {
      if (!ownFlushed && child.name === 'p' && !hasBlockChild(child) && strictNormalize(run.text) === '') {
        for (const c of child.children) inlineText(ctx, c, run);
        if (run.firstNode === null) run.firstNode = child;
        continue;
      }
      if (!ownFlushed) {
        flushRun(ctx, run, li, 'listItem', info);
        ownFlushed = true;
        run = newRun();
      } else {
        flushRun(ctx, run, li, 'paragraph');
        run = newRun();
      }
      handleBlock(ctx, child);
    } else {
      inlineText(ctx, child, run);
    }
  }
  flushRun(ctx, run, li, ownFlushed ? 'paragraph' : 'listItem', info);
}

/** Read only recognized direct line wrappers; never discard extra non-whitespace code children. */
function starlightCode(pre: Element): string {
  if (!ancestor(pre, (node) => hasClass(node, 'expressive-code'))) return visibleCode(pre.children);
  const meaningful = pre.children.filter((node) => !(node instanceof Text && !node.data.trim()));
  const code = meaningful.length === 1 ? meaningful[0] : null;
  if (!(code instanceof Element) || code.name !== 'code') return visibleCode(pre.children);
  const lines = code.children.filter((node) => !(node instanceof Text && !node.data.trim()));
  if (lines.length === 0 || !lines.every((node) => node instanceof Element && node.name === 'div' && hasClass(node, 'ec-line'))) return visibleCode(pre.children);
  // A gutter (line numbers from a plugin) sits beside the code as a direct child of the line; it is not code text.
  const gutter = (node: ChildNode) => node instanceof Element && node.name === 'div' && hasClass(node, 'gutter');
  // starlight-llms-txt prefixes + or - to ins and del lines when the block has a language other than diff. The page
  // shows those lines only through styling, so the marker is in the export and not in the HTML text.
  const language = pre.attribs['data-language'];
  const diffMarkers = Boolean(language) && language !== 'diff'
    && lines.some((line) => line instanceof Element && (hasClass(line, 'ins') || hasClass(line, 'del')));
  return lines.map((line) => starlightLineText((line as Element).children.filter((node) => !gutter(node)), line as Element, diffMarkers)).join('\n');
}

/** One Expressive Code line as starlight-llms-txt exports it. The marker goes before the first text of the first
 * span that is not an indent span; a line whose first such span does not start with text gets no marker. */
function starlightLineText(children: ChildNode[], line: Element, diffMarkers: boolean): string {
  const inserted = hasClass(line, 'ins');
  if (!diffMarkers || !(inserted || hasClass(line, 'del'))) return visibleCode(children);
  const target = firstNonIndentSpan(children)?.children[0];
  if (!(target instanceof Text)) return visibleCode(children);
  let out = '';
  const collect = (nodes: ChildNode[]): void => {
    for (const node of nodes) {
      if (node instanceof Text) out += (node === target ? (inserted ? '+' : '-') : '') + node.data;
      else if (node instanceof Element && !hiddenAttr(node)) collect(node.children);
    }
  };
  collect(children);
  return out;
}

/** The first span without the indent class in document order, the element hast-util-select finds for
 * `span:not(.indent)` inside a line. */
function firstNonIndentSpan(nodes: ChildNode[]): Element | null {
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    if (node.name === 'span' && !hasClass(node, 'indent')) return node;
    const inner = firstNonIndentSpan(node.children);
    if (inner) return inner;
  }
  return null;
}

/** Starlight's Markdown exporter represents every tab as a labelled list item, including inactive panels. */
function handleStarlightTabs(ctx: Ctx, component: Element): void {
  // A tab counts only when nothing between it and the component hides it. A panel counts only as a direct child of
  // the component, the structure Starlight itself queries (':scope > [role="tabpanel"]'). A tab or panel inside a
  // hidden, aria-hidden or otherwise skipped wrapper stays hidden like any other content.
  const shown = (node: Element): boolean => {
    for (let cur: ParentNode | null = node; cur instanceof Element && cur !== component; cur = cur.parent) {
      if (isSkipped(cur, ctx.root, ctx.profile)) return false;
    }
    return true;
  };
  const own = (node: Element) => ancestor(node, (parent) => parent.name === 'starlight-tabs') === component;
  const tabs = selectAll('[role="tab"]', component).filter((node) => own(node) && shown(node));
  const panels = component.children.filter((node): node is Element => node instanceof Element && node.attribs.role === 'tabpanel'
    && !isSkipped(node, ctx.root, ctx.profile, true));
  if (!tabs.length || tabs.length !== panels.length) throw new HtmlExtractError('Starlight tabs need one panel per tab.');
  const panelById = new Map<string, Element>();
  for (const panel of panels) {
    const id = panel.attribs.id;
    if (!id || panelById.has(id)) throw new HtmlExtractError('Starlight panel identifiers are missing or ambiguous.');
    panelById.set(id, panel);
  }
  const controlNodes = new Set<Element>([...tabs, ...panels]);
  // Unknown content beside the tab controls/panels must not disappear from the comparison.
  const validateWrapper = (node: ChildNode): void => {
    if (node instanceof Text) {
      if (node.data.trim()) throw new HtmlExtractError('Unexpected text outside Starlight tab labels and panels.');
      return;
    }
    if (!(node instanceof Element) || controlNodes.has(node)) return;
    if (isSkipped(node, ctx.root, ctx.profile)) return;
    if (node.name === 'iframe') throw new HtmlExtractError('Unexpected content outside Starlight tab labels and panels.');
    for (const child of node.children) validateWrapper(child);
  };
  for (const child of component.children) validateWrapper(child);
  const used = new Set<Element>();
  const ids = new Set<string>();
  for (const tab of tabs) {
    const id = tab.attribs.id;
    const target = tab.attribs['aria-controls'] ?? (tab.attribs.href?.startsWith('#') ? tab.attribs.href.slice(1) : undefined);
    if (!id || ids.has(id) || !target) throw new HtmlExtractError('Starlight tab identifiers are missing or ambiguous.');
    ids.add(id);
    const panel = panelById.get(target);
    if (!panel || panel.attribs['aria-labelledby'] !== id || used.has(panel)) throw new HtmlExtractError('Starlight tab/panel association is missing or ambiguous.');
    used.add(panel);
    // Only the associated panel's initial visibility is bypassed. Hidden descendants remain hidden.
    const label = newRun();
    for (const child of tab.children) inlineText(ctx, child, label);
    if (!strictNormalize(label.text)) throw new HtmlExtractError('Starlight tab label is empty.');
    flushRun(ctx, label, tab, 'listItem', { ordered: false, depth: ctx.listBase, checked: null });
    ctx.listBase++;
    walk(ctx, panel);
    ctx.listBase--;
  }
}

function handleTable(ctx: Ctx, table: Element): void {
  // The caption is content: a paragraph before the table, the way a Markdown table's title has to be written. Up to
  // 0.2.12 it was dropped with its text, numbers and links (found by an outside review 2026-09-26).
  for (const child of table.children) {
    if (child instanceof Element && child.name === 'caption' && !isSkipped(child, ctx.root, ctx.profile)) {
      const run = newRun();
      for (const c of child.children) inlineText(ctx, c, run);
      flushRun(ctx, run, child);
    }
  }
  // Hidden rows, row groups and cells are skipped like any other hidden element (0.2.13; up to 0.2.12 they were read).
  const shown = (tr: Element): boolean => {
    for (let cur: ParentNode | null = tr; cur instanceof Element && cur !== table; cur = cur.parent) {
      if (isSkipped(cur, ctx.root, ctx.profile)) return false;
    }
    return true;
  };
  const rows = selectAll('tr', table).filter((tr) => closestTable(tr) === table && shown(tr));
  const cells: string[][] = [];
  const links: Link[] = [];
  for (const tr of rows) {
    const row: string[] = [];
    for (const cell of tr.children) {
      if (cell instanceof Element && (cell.name === 'td' || cell.name === 'th') && !isSkipped(cell, ctx.root, ctx.profile)) {
        const run = newRun();
        for (const c of cell.children) inlineText(ctx, c, run);
        row.push(strictNormalize(run.text));
        links.push(...run.links);
      }
    }
    if (row.length > 0) cells.push(row);
  }
  if (cells.length === 0) return;
  const text = cells.map((r) => r.join(' | ')).join(' \n ');
  pushBlock(ctx, { type: 'table', text: strictNormalize(text), cells, links }, table, table);
}

function closestTable(el: Element): Element | null {
  let cur: AnyNode | null = el.parent;
  while (cur) {
    if (cur instanceof Element && cur.name === 'table') return cur;
    cur = cur.parent;
  }
  return null;
}

/** Whether the page hides an element: it or an ancestor carries hidden or aria-hidden, or sits in a template. */
function hiddenInPage(el: Element): boolean {
  for (let cur: ParentNode | null = el; cur instanceof Element; cur = cur.parent) {
    if (hiddenAttr(cur) || cur.name === 'template') return true;
  }
  return false;
}

function pickRoot(doc: Document, selector: string | undefined, notes: string[], issues: ExtractionIssue[]): { root: Element; strategy: string; confidence: 'high' | 'low' } {
  if (selector) {
    let matches: Element[];
    try {
      matches = (selectAll(selector, doc.children) as AnyNode[]).filter((n): n is Element => n instanceof Element);
    } catch (err) {
      throw new HtmlExtractError(`Invalid selector "${selector}": ${(err as Error).message}`);
    }
    if (matches.length === 0) throw new HtmlExtractError(`Selector "${selector}" matched no element.`);
    if (matches.length > 1) notes.push(`Selector "${selector}" matched ${matches.length} elements; the first in document order was used.`);
    return { root: matches[0] as Element, strategy: `selector:${selector}`, confidence: 'high' };
  }
  // A candidate the page hides is not its main content. Up to 0.2.12 the first candidate was taken as it was, so a
  // hidden <main> before the visible one was compared in its place and the visible content not at all. Candidates
  // that do not sit inside one another are separate content, and only the first is compared, so that is a warning;
  // one nested inside another (an <article> inside an <article>) is part of it (found by an outside review 2026-09-26).
  for (const tag of ['main', 'article', '[role=main]']) {
    const matches = (selectAll(tag, doc.children) as AnyNode[]).filter((n): n is Element => n instanceof Element);
    const visible = matches.filter((el) => !hiddenInPage(el));
    if (matches.length > visible.length) notes.push(`${matches.length - visible.length} hidden <${tag}> element(s) were not used as the main content.`);
    if (visible.length >= 1) {
      const set = new Set(visible);
      const outer = visible.filter((el) => {
        for (let cur: ParentNode | null = el.parent; cur instanceof Element; cur = cur.parent) if (set.has(cur)) return false;
        return true;
      });
      if (outer.length > 1) {
        issues.push({ code: 'EXTRACTION_MULTIPLE_ROOTS', severity: 'warning', message: `${outer.length} visible <${tag}> elements that do not contain one another were found; only the first in document order was compared. Use --selector to choose the content.` });
      } else if (visible.length > 1) {
        notes.push(`${visible.length} <${tag}> elements found, nested inside the first; the first was used.`);
      }
      return { root: outer[0] as Element, strategy: tag, confidence: 'high' };
    }
  }
  const body = selectOne('body', doc.children) as AnyNode | null;
  if (body instanceof Element) {
    notes.push('No <main>, <article> or [role=main] element; fell back to <body> with lower extraction confidence.');
    return { root: body, strategy: 'body-fallback', confidence: 'low' };
  }
  throw new HtmlExtractError('Document has no <body> element.');
}

export function extractHtml(source: string, options: HtmlExtractOptions = {}): Extraction {
  const profile = options.profile ?? 'generic';
  if (profile !== 'generic' && profile !== 'starlight') throw new HtmlExtractError('Unknown HTML profile.');
  const doc = parseDocument(source, { withStartIndices: true, withEndIndices: true, decodeEntities: true });
  // Before any selector runs: the selector engine and the extraction below both recurse over the tree.
  const maxDepth = options.maxDepth ?? MAX_NESTING_DEPTH;
  const depth = nestingDepth(doc);
  if (depth > maxDepth) throw new HtmlExtractError(`HTML nesting depth ${depth} exceeds the limit of ${maxDepth} levels; the comparison was not run.`);
  const notes: string[] = [];
  const issues: ExtractionIssue[] = [];
  const baseEl = selectOne('base[href]', doc.children) as AnyNode | null;
  let base: string | null = options.baseUrl ?? null;
  if (baseEl instanceof Element && baseEl.attribs['href']) {
    const resolved = resolveHref(baseEl.attribs['href'], base);
    if (resolved) base = resolved;
  }
  const { root, strategy, confidence } = pickRoot(doc, options.selector, notes, issues);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  if (profile === 'starlight') notes.push('Starlight profile: all associated tab panels are compared, including inactive panels; Expressive Code line boundaries and aside titles are retained.');
  const ctx: Ctx = { profile, base, source, lineStarts, blocks: [], notes, root, listBase: 0, ordinals: new Map(), segments: new Map() };
  // A selector that picks a heading, list item, table or pre keeps that block type, so the root goes
  // through handleBlock. Every other root is read as a container, a list included: handleBlock's list
  // branch reads only <li> children, and a root list would lose any other content it holds.
  if (HEADING_RE.test(root.name) || root.name === 'li' || root.name === 'table' || root.name === 'pre') handleBlock(ctx, root);
  else walk(ctx, root);
  return { blocks: ctx.blocks, strategy: profile === 'generic' ? strategy : `${strategy};profile:starlight`, confidence, notes, issues };
}
