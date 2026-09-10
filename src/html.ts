// HTML main-content extraction into the shared block model. Uses htmlparser2 (parsing) and css-select
// (selectors). No JavaScript is executed; dynamic pages are compared as served.

import { parseDocument } from 'htmlparser2';
import { selectAll, selectOne } from 'css-select';
import { Element, Text, type AnyNode, type ChildNode, type Document } from 'domhandler';
import { textContent } from 'domutils';
import type { Block, Extraction, Link } from './model.js';
import { extractNumbers, looseNormalize, normalizeCode, resolveHref, strictNormalize } from './normalize.js';

export interface HtmlExtractOptions {
  /** User supplied CSS selector for the main content. */
  selector?: string;
  /** Base URL for resolving relative links; a <base href> in the document takes precedence. */
  baseUrl?: string | null;
}

export class HtmlExtractError extends Error {}

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'nav', 'iframe', 'svg', 'canvas', 'object', 'embed', 'map', 'form', 'button', 'input', 'select', 'textarea', 'dialog']);
const SKIP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar', 'dialog']);
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'summary', 'dd', 'dl', 'dt', 'div', 'fieldset', 'figcaption', 'figure', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'body', 'html', 'center', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'caption']);
const HEADING_RE = /^h([1-6])$/;

interface Ctx {
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

function isSkipped(el: Element, root: Element): boolean {
  if (SKIP_TAGS.has(el.name)) return true;
  const role = (el.attribs['role'] ?? '').toLowerCase();
  if (SKIP_ROLES.has(role)) return true;
  if (el.attribs['hidden'] !== undefined || el.attribs['aria-hidden'] === 'true') return true;
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
  if (isSkipped(node, ctx.root)) return;
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
    if (child instanceof Element && isSkipped(child, ctx.root)) continue;
    if (child instanceof Element && BLOCK_TAGS.has(child.name)) {
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
    const code = normalizeCode(textContent(el));
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
    if (child instanceof Element && isSkipped(child, ctx.root)) continue;
    if (child instanceof Element && BLOCK_TAGS.has(child.name)) {
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
  const doc = parseDocument(source, { withStartIndices: true, withEndIndices: true, decodeEntities: true });
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
  const ctx: Ctx = { base, source, lineStarts, blocks: [], notes, root };
  walk(ctx, root);
  return { blocks: ctx.blocks, strategy, confidence, notes, issues: [] };
}
