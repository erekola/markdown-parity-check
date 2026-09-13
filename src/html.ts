// HTML main-content extraction into the shared block model. Uses htmlparser2 (parsing) and css-select
// (selectors). No JavaScript is executed; dynamic pages are compared as served.

import { parseDocument } from 'htmlparser2';
import { selectAll, selectOne } from 'css-select';
import { Element, Text, type AnyNode, type ChildNode, type Document, type ParentNode } from 'domhandler';
import { textContent } from 'domutils';
import type { Block, Extraction, Link } from './model.js';
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
    let index = 1;
    let sib = cur.prev;
    while (sib) {
      if (sib instanceof Element && sib.name === cur.name) index++;
      sib = sib.prev;
    }
    parts.unshift(index > 1 || hasLaterSameNamedSibling(cur) ? `${cur.name}:nth-of-type(${index})` : cur.name);
    if (cur === ctx.root) break;
    cur = cur.parent instanceof Element ? cur.parent : null;
  }
  return parts.join(' > ');
}

function hasLaterSameNamedSibling(el: Element): boolean {
  let sib = el.next;
  while (sib) {
    if (sib instanceof Element && sib.name === el.name) return true;
    sib = sib.next;
  }
  return false;
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

function isSkipped(el: Element, root: Element, profile: 'generic' | 'starlight' = 'generic', ignoreHidden = false): boolean {
  if (SKIP_TAGS.has(el.name)) return true;
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

function flushRun(ctx: Ctx, run: InlineRun, container: Element, type: 'paragraph' | 'listItem' = 'paragraph'): void {
  const text = strictNormalize(run.text);
  if (text === '') return;
  const node = run.firstNode ?? container;
  pushBlock(ctx, { type, text, links: run.links }, node, container);
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
    const code = normalizeCode(ctx.profile === 'starlight' ? starlightCode(el) : textContent(el));
    if (code.trim() !== '') pushBlock(ctx, { type: 'code', text: strictNormalize(code), code, links: [] }, el, el);
    return;
  }
  if (el.name === 'table') {
    handleTable(ctx, el);
    return;
  }
  if (el.name === 'ul' || el.name === 'ol') {
    for (const c of el.children) {
      if (c instanceof Element && c.name === 'li') handleListItem(ctx, c);
      else if (c instanceof Element && (c.name === 'ul' || c.name === 'ol')) handleBlock(ctx, c);
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

function handleListItem(ctx: Ctx, li: Element): void {
  // The item's own inline text (and inline text of a leading <p>) becomes one listItem block; nested lists
  // and other block children recurse.
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
        flushRun(ctx, run, li, 'listItem');
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
  flushRun(ctx, run, li, ownFlushed ? 'paragraph' : 'listItem');
}

/** Read only recognized direct line wrappers; never discard extra non-whitespace code children. */
function starlightCode(pre: Element): string {
  if (!ancestor(pre, (node) => hasClass(node, 'expressive-code'))) return textContent(pre);
  const meaningful = pre.children.filter((node) => !(node instanceof Text && !node.data.trim()));
  const code = meaningful.length === 1 ? meaningful[0] : null;
  if (!(code instanceof Element) || code.name !== 'code') return textContent(pre);
  const lines = code.children.filter((node) => !(node instanceof Text && !node.data.trim()));
  if (lines.length === 0 || !lines.every((node) => node instanceof Element && node.name === 'div' && hasClass(node, 'ec-line'))) return textContent(pre);
  // A gutter (line numbers from a plugin) sits beside the code as a direct child of the line; it is not code text.
  const gutter = (node: ChildNode) => node instanceof Element && node.name === 'div' && hasClass(node, 'gutter');
  return lines.map((line) => textContent((line as Element).children.filter((node) => !gutter(node)))).join('\n');
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
    flushRun(ctx, label, tab, 'listItem');
    walk(ctx, panel);
  }
}

function handleTable(ctx: Ctx, table: Element): void {
  const rows = selectAll('tr', table).filter((tr) => closestTable(tr) === table);
  const cells: string[][] = [];
  const links: Link[] = [];
  for (const tr of rows) {
    const row: string[] = [];
    for (const cell of tr.children) {
      if (cell instanceof Element && (cell.name === 'td' || cell.name === 'th')) {
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

function pickRoot(doc: Document, selector: string | undefined, notes: string[]): { root: Element; strategy: string; confidence: 'high' | 'low' } {
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
  for (const tag of ['main', 'article', '[role=main]']) {
    const matches = (selectAll(tag, doc.children) as AnyNode[]).filter((n): n is Element => n instanceof Element);
    if (matches.length >= 1) {
      if (matches.length > 1) notes.push(`${matches.length} <${tag}> elements found; the first in document order was used.`);
      return { root: matches[0] as Element, strategy: tag, confidence: 'high' };
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
  const baseEl = selectOne('base[href]', doc.children) as AnyNode | null;
  let base: string | null = options.baseUrl ?? null;
  if (baseEl instanceof Element && baseEl.attribs['href']) {
    const resolved = resolveHref(baseEl.attribs['href'], base);
    if (resolved) base = resolved;
  }
  const { root, strategy, confidence } = pickRoot(doc, options.selector, notes);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  if (profile === 'starlight') notes.push('Starlight profile: all associated tab panels are compared, including inactive panels; Expressive Code line boundaries and aside titles are retained.');
  const ctx: Ctx = { profile, base, source, lineStarts, blocks: [], notes, root };
  walk(ctx, root);
  return { blocks: ctx.blocks, strategy: profile === 'generic' ? strategy : `${strategy};profile:starlight`, confidence, notes, issues: [] };
}
