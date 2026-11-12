// Markdown extraction into the shared block model, using mdast-util-from-markdown with GFM extensions.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes, Parent, PhrasingContent, Root, RootContent, Table } from 'mdast';
import type { Block, Extraction, ExtractionIssue, Link, ListInfo } from './model.js';
import { BLOCK_TAGS, extractHtml, HtmlDepthError, MAX_NESTING_DEPTH, opensExcludedSubtree } from './html.js';
import { parseDocument, Parser } from 'htmlparser2';
import { Element, Text, type ChildNode } from 'domhandler';
import { excerpt, extractNumbers, insideHiddenUrlPart, looseNormalize, normalizeCode, resolveHref, strictNormalize } from './normalize.js';

export interface MarkdownExtractOptions {
  baseUrl?: string | null;
  /**
   * 'keep' (default): nothing is removed; a document that starts with a fence that looks like YAML front
   * matter is compared as written and flagged with a warning. 'strip': the user has said the document
   * carries front matter, so the leading fenced block is removed and reported as info.
   */
  frontMatter?: 'keep' | 'strip';
  /** Deepest node nesting accepted in the parsed Markdown tree. Default MAX_NESTING_DEPTH. */
  maxDepth?: number;
}

export class MarkdownExtractError extends Error {}

/** Deepest node nesting of a Markdown tree, counted with an explicit stack. */
function treeDepth(tree: Root): number {
  let max = 0;
  const stack: Array<[Nodes, number]> = [[tree, 0]];
  while (stack.length > 0) {
    const [n, d] = stack.pop()!;
    if (d > max) max = d;
    if ('children' in n) for (const c of (n as Parent).children) stack.push([c as Nodes, d + 1]);
  }
  return max;
}

interface Ctx {
  base: string | null;
  /** The text handed to the parser, which the node offsets point into. */
  source: string;
  blocks: Block[];
  notes: string[];
  issues: ExtractionIssue[];
  /** Link reference definitions by normalized identifier (first definition wins, per CommonMark). */
  definitions: Map<string, { url: string; title: string | null }>;
  /** Nesting level of the list being read, 0 at the top. */
  listDepth: number;
  /** The caller's nesting limit, handed on to every raw HTML block (the synthetic body wrapper is not counted). */
  maxDepth: number;
  /** Raw HTML elements still open at the end of the last raw HTML block, the whole stack from the outermost one. A
   * wrapper such as <div hidden> or <nav> opened in one Markdown block and closed in a later one hides the blocks
   * between, and a visible <a href> gives them its link. The visible ones stay in the stack because their closing
   * tags close what is open inside them. */
  wrappers: Wrapper[];
}

interface Wrapper {
  name: string;
  /** The element hides what it holds: hidden, aria-hidden, or a subtree the HTML side leaves out (nav, form, a role). */
  covers: boolean;
  /** The href of a visible anchor, which the blocks inside get as their link. */
  href?: string;
}

interface InlineRun {
  text: string;
  links: Link[];
}

interface InlineTag {
  name: string;
  closing: boolean;
  /** The tag ends in "/>" as written. */
  selfClosing?: boolean;
  attribs: Record<string, string>;
}

/** Parses one inline HTML node (a single tag, per micromark) with htmlparser2. Returns null for comments,
 * processing instructions or anything that is not exactly one tag. */
function parseInlineTag(value: string): InlineTag | null {
  const v = value.trim();
  const closing = /^<\/[A-Za-z]/.test(v);
  if (closing) {
    const m = /^<\/([A-Za-z][A-Za-z0-9-]*)\s*>$/.exec(v);
    return m ? { name: m[1]!.toLowerCase(), closing: true, attribs: {} } : null;
  }
  const tag = singleOpenTag(v);
  if (!tag) return null;
  return { name: tag.name.toLowerCase(), closing: false, selfClosing: /\/\s*>$/.test(v), attribs: tag.attribs };
}

/** The one opening tag a string consists of, found by the HTML tokenizer so that a quoted attribute value may hold a
 * ">" (title="A > B"); null when the string is anything else: text after the tag, a comment, a tag still open at the
 * end. The first version looked for the closing ">" with a pattern and cut the tag at a quoted one (MP-02). */
function singleOpenTag(v: string): { name: string; attribs: Record<string, string> } | null {
  if (!/^<[A-Za-z]/.test(v)) return null;
  const seen: { tag: { name: string; attribs: Record<string, string>; end: number } | null; extra: boolean } = { tag: null, extra: false };
  const parser: Parser = new Parser({
    onopentag(name, attribs) {
      if (seen.tag) seen.extra = true;
      else seen.tag = { name, attribs, end: parser.endIndex };
    },
    ontext() { seen.extra = true; },
    oncomment() { seen.extra = true; },
    onprocessinginstruction() { seen.extra = true; },
  }, { decodeEntities: true });
  parser.write(v);
  if (!seen.tag || seen.extra || seen.tag.end !== v.length - 1) return null;
  return { name: seen.tag.name, attribs: seen.tag.attribs };
}

/**
 * Walks phrasing children in order so that inline HTML anchors (<a href="..">text</a>) become links with
 * their Markdown child text. Other inline tags are structure, not content: <img> contributes its alt
 * text, <br> a space, everything else is dropped while the text between tags stays.
 */
function inlineChildren(ctx: Ctx, children: PhrasingContent[], run: InlineRun, line?: number): void {
  let closes: Map<number, number> | null = null;
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    if (node.type !== 'html') {
      inline(ctx, node, run);
      continue;
    }
    const tag = parseInlineTag(node.value);
    if (!tag) continue; // comment or unparsable fragment: no visible content
    // A hidden inline element hides its text in a reader that renders the HTML, as the same attribute does on the
    // HTML side. Up to 0.2.12 only the tags were dropped and the text between them stayed (found by an outside review
    // 2026-09-26). Its content up to the matching closing tag is left out; without one the tag is reported.
    // An inline element the HTML side leaves out (a button, a script, a nav, a role such as navigation) is skipped the
    // same way: up to 0.2.21 only its tags were dropped and its text compared as visible (0.2.22, found by an outside
    // review 2026-10-02).
    // A left-out foreign element written as self-closing (<svg/>) is closed and empty, as the HTML parser reads it:
    // there is nothing to skip through and nothing to report. Any other tag with a trailing slash is not closed in
    // HTML (<button/> stays open), so it takes the normal path below. Void elements already end at their own tag.
    if (!tag.closing && tag.selfClosing && FOREIGN_TAGS.has(tag.name) && opensExcludedSubtree(tag.name, tag.attribs)) continue;
    const hiddenTag = tag.attribs['hidden'] !== undefined || tag.attribs['aria-hidden'] === 'true';
    if (!tag.closing && (hiddenTag || opensExcludedSubtree(tag.name, tag.attribs))) {
      // A trailing "/>" on a non-void element is not a self-close in HTML: <span hidden/>text</span> does not
      // show "text" in a browser either, only a void element's own tag ends there. Up to 0.2.15 the slash alone
      // was read as a close, so a malformed but common self-closing spelling left hidden text visible (0.2.16,
      // found by an outside review 2026-09-28).
      if (VOID_TAGS.has(tag.name)) continue;
      closes ??= closingTags(children);
      const end = closes.get(i) ?? -1;
      if (end < 0) {
        ctx.issues.push({ code: 'MARKDOWN_INLINE_HTML_UNSUPPORTED', severity: 'warning', message: `A ${hiddenTag ? 'hidden' : 'left-out'} inline <${tag.name}> has no matching </${tag.name}> in the same paragraph; its text was compared as visible.`, line: node.position?.start.line ?? line, excerpt: excerpt(node.value) });
        continue;
      }
      i = end;
      continue;
    }
    if (tag.closing) {
      if (tag.name === 'a') ctx.issues.push({ code: 'MARKDOWN_INLINE_HTML_UNSUPPORTED', severity: 'warning', message: 'A closing </a> without an opening <a> in the same paragraph; the inline HTML structure could not be resolved reliably.', line: node.position?.start.line ?? line, excerpt: excerpt(node.value) });
      continue;
    }
    if (tag.name === 'img') {
      const alt = tag.attribs['alt'];
      if (alt && alt.trim()) run.text += ` ${alt} `;
      continue;
    }
    if (tag.name === 'br') {
      run.text += ' ';
      continue;
    }
    if (tag.name !== 'a') continue; // span, em, strong, sup, ...: the text is in sibling nodes
    // Find the matching </a> among the following siblings.
    let end = -1;
    for (let j = i + 1; j < children.length; j++) {
      const c = children[j]!;
      if (c.type === 'html') {
        const t = parseInlineTag(c.value);
        if (t && t.name === 'a') {
          if (t.closing) {
            end = j;
            break;
          }
          break; // nested <a>: unsupported
        }
      }
    }
    if (end < 0) {
      ctx.issues.push({ code: 'MARKDOWN_INLINE_HTML_UNSUPPORTED', severity: 'warning', message: 'An inline <a> tag has no matching </a> in the same paragraph (or anchors are nested); its link was not compared.', line: node.position?.start.line ?? line, excerpt: excerpt(node.value) });
      continue;
    }
    const inner: InlineRun = { text: '', links: [] };
    inlineChildren(ctx, children.slice(i + 1, end), inner, line);
    const href = tag.attribs['href'];
    if (href !== undefined) run.links.push({ text: strictNormalize(inner.text), rawHref: href, resolved: resolveHref(href, ctx.base) });
    run.links.push(...inner.links);
    run.text += inner.text;
    i = end;
  }
}

// Foreign elements that may close themselves with a trailing slash. Of the two, only svg is a left-out tag of its own
// (SKIP_TAGS in html.ts); math is left out only when it carries a left-out role such as navigation, so for math the
// self-closing rule above applies only in that case.
const FOREIGN_TAGS = new Set(['svg', 'math']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * For every opening tag among the inline nodes of a paragraph, the index of its matching closing tag, counting
 * nested tags of the same name; an opening tag without one is absent. One pass with a stack per tag name, computed
 * once per paragraph. The first version scanned forward from each hidden tag, so a paragraph with 20 000 unclosed
 * hidden tags took two minutes (found by an independent review before 0.2.13 was released).
 */
function closingTags(children: PhrasingContent[]): Map<number, number> {
  const out = new Map<number, number>();
  const open = new Map<string, number[]>();
  children.forEach((c, j) => {
    if (c.type !== 'html') return;
    const t = parseInlineTag(c.value);
    if (!t) return;
    const stack = open.get(t.name) ?? [];
    if (!t.closing) {
      stack.push(j);
      open.set(t.name, stack);
    } else if (stack.length > 0) {
      out.set(stack.pop()!, j);
    }
  });
  return out;
}

function inline(ctx: Ctx, node: PhrasingContent | Nodes, run: InlineRun): void {
  switch (node.type) {
    case 'text':
      run.text += node.value;
      return;
    case 'inlineCode':
      run.text += node.value;
      return;
    case 'break':
      run.text += ' ';
      return;
    case 'image':
      if (node.alt && node.alt.trim()) run.text += ` ${node.alt} `;
      return;
    case 'imageReference':
      if (node.alt && node.alt.trim()) run.text += ` ${node.alt} `;
      return;
    case 'html':
      // Inline raw HTML is a tag, not content: the text around it is in sibling text nodes.
      return;
    case 'linkReference': {
      const inner: InlineRun = { text: '', links: [] };
      inlineChildren(ctx, node.children, inner, node.position?.start.line);
      const def = ctx.definitions.get(node.identifier);
      if (def) {
        run.links.push({ text: strictNormalize(inner.text), rawHref: def.url, resolved: resolveHref(def.url, ctx.base) });
        run.links.push(...inner.links);
        run.text += inner.text;
      } else {
        // Unreachable with micromark, which only emits a reference that has a definition; kept as a safe
        // fallback that treats an unresolved reference as literal text.
        run.text += `[${inner.text}]`;
        run.links.push(...inner.links);
      }
      return;
    }
    case 'link': {
      const inner: InlineRun = { text: '', links: [] };
      inlineChildren(ctx, node.children, inner, node.position?.start.line);
      const link: Link = { text: strictNormalize(inner.text), rawHref: node.url, resolved: resolveHref(node.url, ctx.base) };
      // A GFM literal autolink starts with neither [ nor <. One that GFM found inside a hidden part of another URL
      // is compared as usual but shown masked (0.2.12).
      const at = node.position?.start.offset;
      if (at !== undefined && ctx.source[at] !== '[' && ctx.source[at] !== '<' && insideHiddenUrlPart(ctx.source, at)) link.masked = true;
      run.links.push(link);
      run.links.push(...inner.links);
      run.text += inner.text;
      return;
    }
    case 'footnoteReference':
      return;
    default:
      if ('children' in node) {
        inlineChildren(ctx, (node as Parent).children as PhrasingContent[], run, node.position?.start.line);
      } else if ('value' in node && typeof (node as { value?: unknown }).value === 'string') {
        run.text += (node as { value: string }).value;
      }
  }
}

function push(ctx: Ctx, partial: Omit<Block, 'loose' | 'numbers' | 'location'>, node: Nodes): void {
  const line = node.position?.start.line;
  const block: Block = {
    ...partial,
    loose: looseNormalize(partial.text),
    numbers: extractNumbers(partial.text),
    location: { line, blockIndex: ctx.blocks.length },
  };
  // A visible raw <a href> left open by an earlier raw HTML block links the blocks inside it, the way the HTML side
  // gives every block of a block anchor the anchor's link with the block's own text; the outermost link comes first (MP-08).
  for (let i = ctx.wrappers.length - 1; i >= 0; i--) {
    const href = ctx.wrappers[i]!.href;
    if (href !== undefined) block.links.unshift({ text: strictNormalize(block.text), rawHref: href, resolved: resolveHref(href, ctx.base) });
  }
  ctx.blocks.push(block);
}

function handleTable(ctx: Ctx, table: Table, listItem?: ListInfo): void {
  const cells: string[][] = [];
  const links: Link[] = [];
  for (const row of table.children) {
    const r: string[] = [];
    for (const cell of row.children) {
      const run: InlineRun = { text: '', links: [] };
      inlineChildren(ctx, cell.children, run, cell.position?.start.line);
      r.push(strictNormalize(run.text));
      links.push(...run.links);
    }
    cells.push(r);
  }
  if (cells.length === 0) return;
  const text = cells.map((r) => r.join(' | ')).join(' \n ');
  push(ctx, { type: 'table', text: strictNormalize(text), cells, links, ...(listItem ? { list: listItem } : {}) }, table);
}

const LEADING_TYPES = new Set<string>(['paragraph', 'heading', 'code', 'table', 'html']);

function handle(ctx: Ctx, node: RootContent, listItem?: ListInfo): void {
  switch (node.type) {
    case 'heading': {
      if (hiddenWrapped(ctx)) return;
      const run: InlineRun = { text: '', links: [] };
      inlineChildren(ctx, node.children, run, node.position?.start.line);
      const text = strictNormalize(run.text);
      if (text !== '') push(ctx, { type: 'heading', text, depth: node.depth, links: run.links, ...(listItem ? { list: listItem } : {}) }, node);
      return;
    }
    case 'paragraph': {
      if (hiddenWrapped(ctx)) return;
      const run: InlineRun = { text: '', links: [] };
      inlineChildren(ctx, node.children, run, node.position?.start.line);
      const text = strictNormalize(run.text);
      if (text !== '') push(ctx, { type: listItem ? 'listItem' : 'paragraph', text, links: run.links, ...(listItem ? { list: listItem } : {}) }, node);
      return;
    }
    case 'code': {
      if (hiddenWrapped(ctx)) return;
      const code = normalizeCode(node.value);
      if (code.trim() !== '') push(ctx, { type: 'code', text: strictNormalize(code), code, links: [], ...(listItem ? { list: listItem } : {}) }, node);
      return;
    }
    case 'table':
      if (!hiddenWrapped(ctx)) handleTable(ctx, node, listItem);
      return;
    case 'list': {
      // A Markdown list shows its start number and counts on; its items carry the list kind, the nesting level and
      // the task state for the comparison (0.2.13).
      let n = typeof node.start === 'number' ? node.start : 1;
      for (const item of node.children) {
        const info: ListInfo = { ordered: node.ordered === true, depth: ctx.listDepth, checked: typeof item.checked === 'boolean' ? item.checked : null };
        if (node.ordered === true) info.ordinal = n;
        n++;
        ctx.listDepth++;
        let first = true;
        for (const child of item.children) {
          // The first child carries the item's list context whatever it is: a paragraph is the item text, a heading,
          // code, a table or raw HTML keep their own type with the context on them (MP-05, MP-06).
          handle(ctx, child, first && LEADING_TYPES.has(child.type) ? info : undefined);
          first = false;
        }
        ctx.listDepth--;
      }
      return;
    }
    case 'blockquote':
      for (const c of node.children) handle(ctx, c);
      return;
    case 'html':
      handleRawHtml(ctx, node.value, node.position?.start.line, listItem);
      return;
    case 'footnoteDefinition':
      if (hiddenWrapped(ctx)) return;
      // Footnotes are not compared: an HTML page renders them as a numbered list with back links, which would not
      // read as the Markdown definitions. Up to 0.2.12 a definition was dropped without a trace, so a footnote added
      // to the Markdown passed strict mode (found by an outside review 2026-09-26). It is now a warning with its text.
      ctx.issues.push({ code: 'MARKDOWN_FOOTNOTE_NOT_COMPARED', severity: 'warning', message: `Footnote [^${node.identifier}] is not compared; its text, numbers and links were left out of the comparison.`, line: node.position?.start.line, excerpt: excerpt(footnoteText(node)) });
      return;
    case 'thematicBreak':
    case 'definition':
    case 'yaml':
      return;
    default:
      if ('children' in node) for (const c of (node as Parent).children) handle(ctx, c as RootContent);
  }
}

/** Plain text of a footnote definition for the report excerpt. */
function footnoteText(node: Nodes): string {
  if ('value' in node && typeof (node as { value?: unknown }).value === 'string') return (node as { value: string }).value;
  if ('children' in node) return (node as Parent).children.map((c) => footnoteText(c as Nodes)).join(' ');
  return '';
}

/** A raw HTML block in Markdown is parsed with the HTML extractor so its content takes part in the
 * comparison; the report shows that this happened. Comments and bare tags without text yield nothing. */
function handleRawHtml(ctx: Ctx, value: string, line: number | undefined, listItem?: ListInfo): void {
  // Wrappers an earlier raw block left open are written in front of this one, on the same line, so the extractor
  // sees the same element tree a browser would and hides what a covering wrapper still holds (P07). A wrapper that
  // hides is written with the hidden attribute whatever hid it, and an anchor with its href.
  const prefix = ctx.wrappers.map((w) => `<${w.name}${w.covers ? ' hidden' : ''}${w.href !== undefined ? ` href="${w.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` : ''}>`).join('');
  // The stack always follows the prefix, because a closing tag here may end an element opened earlier. The extractor
  // sees the prefix only while an open element hides content or links it: with nothing of the kind open the block is
  // read on its own, as before (a long run of unclosed visible tags costs the stack but no tree per block).
  const relevant = ctx.wrappers.some((w) => w.covers || w.href !== undefined);
  ctx.wrappers = openWrappers(prefix + value);
  if (ctx.wrappers.length > ctx.maxDepth) throw new HtmlDepthError(ctx.wrappers.length, ctx.maxDepth);
  const fragment = relevant ? prefix + value : value;
  // Text check for the fallback warning, taken from the parsed DOM rather than from regex stripping:
  // comments are not text, and script, style, template and noscript are page machinery on both sides,
  // so their content does not count as skipped text. Hidden elements are left out, as in the extraction.
  const textOnly = visibleText(fragment);
  let parsed: Extraction | null = null;
  try {
    parsed = extractHtml(`<body>${fragment}</body>`, { selector: 'body', baseUrl: ctx.base, maxDepth: ctx.maxDepth + 1 });
  } catch (err) {
    // A block nested past the caller's limit stops the comparison like the same nesting in the HTML page does
    // (run.ts turns this into the RunError, exit 2). Any other parse failure still falls back to the warning.
    // The wrapper body is one level the block does not have, so the limit passed above is one higher and the
    // reported depth one lower: the block is held to the same limit, and reported in the same terms, as the
    // same element tree on the HTML side.
    if (err instanceof HtmlDepthError) throw new HtmlDepthError(err.depth - 1, ctx.maxDepth);
    parsed = null;
  }
  const blocks = parsed?.blocks ?? [];
  if (blocks.length > 0) {
    let lead = listItem !== undefined && rawLeadsItem(value);
    for (const b of blocks) {
      // The wrapper <body> sits on the fragment's first line, so the extractor's line is 1-based within
      // the fragment and maps onto the html node's start line.
      const inner = b.location.line;
      const absolute = line !== undefined && inner !== undefined ? line + inner - 1 : line;
      let block: Block = { ...b, location: { line: absolute, blockIndex: ctx.blocks.length } };
      // A list inside a raw block sits below the Markdown list the block is in (MP-05).
      if (block.list && ctx.listDepth > 0) block = { ...block, list: { ...block.list, depth: block.list.depth + ctx.listDepth } };
      // The first block of a raw block that leads a Markdown list item is the item's own text, or the item's leading
      // heading, code or table, and carries the item's list context (MP-05, MP-06). A nested list there has its own.
      if (lead) {
        lead = false;
        if (!block.list && listItem) block = { ...block, ...(block.type === 'paragraph' ? { type: 'listItem' as const } : {}), list: { ...listItem } };
      }
      ctx.blocks.push(block);
    }
    // The nested extraction's own structural "not compared" issues (a spanned table, a reversed list) were
    // read off parsed.blocks only up to here; parsed.issues was silently dropped, so a page whose span or
    // reversed numbering lived inside a raw HTML block in the Markdown showed only the generic
    // MARKDOWN_RAW_HTML_PARSED note about readers that do not render HTML, with no disclosure that the span
    // or the numbering itself was not reliably compared (N-P-raw-html, found by an outside review
    // 2026-09-28). The line offset matches the block loop just above.
    for (const i of parsed?.issues ?? []) {
      const absolute = line !== undefined && i.line !== undefined ? line + i.line - 1 : line;
      ctx.issues.push({ ...i, line: absolute });
    }
    ctx.issues.push({ code: 'MARKDOWN_RAW_HTML_PARSED', severity: 'info', message: `A raw HTML block in the Markdown was parsed as HTML (${blocks.length} block(s)); Markdown readers that do not render HTML will not see it.`, line, excerpt: excerpt(textOnly) });
  } else if (textOnly !== '') {
    ctx.issues.push({ code: 'MARKDOWN_RAW_HTML_SKIPPED', severity: 'warning', message: 'A raw HTML block in the Markdown carries text that could not be parsed into blocks; it was not compared.', line, excerpt: excerpt(textOnly) });
  }
}

/**
 * Whether a raw HTML block that leads a Markdown list item is read as the item's own content, by the rule of html.ts
 * handleListItem: the item's own text or inline content, a paragraph without block children, a heading, a pre or a
 * table. Any other block element (div, blockquote, section, details, a list) is a block child of the item and gets no
 * list context, as on the HTML side (N-1).
 */
function rawLeadsItem(value: string): boolean {
  for (const node of parseDocument(value).children) {
    if (node instanceof Text) {
      if (node.data.trim() !== '') return true;
      continue;
    }
    if (!(node instanceof Element)) continue;
    const name = node.name.toLowerCase();
    if (opensExcludedSubtree(name, node.attribs) || node.attribs['hidden'] !== undefined || node.attribs['aria-hidden'] === 'true') continue;
    if (name === 'p') return !node.children.some((c) => c instanceof Element && BLOCK_TAGS.has(c.name.toLowerCase()));
    if (/^h[1-6]$/.test(name) || name === 'pre' || name === 'table') return true;
    return !BLOCK_TAGS.has(name);
  }
  return false;
}

/** Whether a raw HTML wrapper from an earlier block that hides what it holds is still open. */
function hiddenWrapped(ctx: Ctx): boolean {
  return ctx.wrappers.some((w) => w.covers);
}

/**
 * The elements still open at the end of a raw HTML fragment, all of them from the outermost. An element hides content
 * when it is hidden or aria-hidden or the HTML side leaves its subtree out (a nav, a form, a role such as navigation);
 * a visible anchor with an href links what it holds. The visible elements are kept as well, because an element opened
 * in an earlier block can be hidden or linked only by a later one, and because their closing tags close what is open
 * inside them: </ul> ends an open <li hidden> (MP-07). The parser is not ended, because ending it closes every open
 * element and the open ones are the answer. The stack is written in front of every following raw block, so the caller
 * stops the comparison when it is deeper than the nesting limit, as the same nesting is on the HTML side.
 */
function openWrappers(fragment: string): Wrapper[] {
  const stack: Wrapper[] = [];
  const parser = new Parser({
    onopentag(name, attribs) {
      const covers = attribs['hidden'] !== undefined || attribs['aria-hidden'] === 'true' || opensExcludedSubtree(name, attribs);
      const wrapper: Wrapper = { name, covers };
      if (name === 'a' && attribs['href'] !== undefined && !covers) wrapper.href = attribs['href'];
      stack.push(wrapper);
    },
    onclosetag() {
      stack.pop();
    },
  }, { decodeEntities: true });
  parser.write(fragment);
  return stack;
}

/** Strictly normalized text of an HTML fragment as a parser sees it: text nodes only, comments and
 * machinery elements excluded. */
function visibleText(fragment: string): string {
  const parts: string[] = [];
  const walk = (nodes: ChildNode[]): void => {
    for (const node of nodes) {
      if (node instanceof Text) parts.push(node.data);
      else if (node instanceof Element) {
        // The subtrees the HTML side leaves out (script, style, template, noscript, nav, form, dialog, a role such as
        // navigation and the rest of opensExcludedSubtree) are not text that was left unread (MP-04).
        if (opensExcludedSubtree(node.name.toLowerCase(), node.attribs)) continue;
        if (node.attribs['hidden'] !== undefined || node.attribs['aria-hidden'] === 'true') continue;
        walk(node.children);
      }
    }
  };
  walk(parseDocument(fragment).children);
  return strictNormalize(parts.join(' '));
}

const YAML_LINE = /^(?:[A-Za-z0-9_.-]+\s*:(?:\s|$)|\s+\S|-\s|#)/;
const FENCE_RE = /^(?:\ufeff)?---[ \t]*(?:\r\n|\r(?!\n)|\n)([\s\S]*?)(?:\r\n|\r(?!\n)|\n)(?:---|\.\.\.)[ \t]*(?:\r\n|\r(?!\n)|\n|$)/;

interface FrontMatterScan {
  /** Text handed to the parser. */
  text: string;
  /** Number of source lines removed (0 when nothing was removed). */
  skippedLines: number;
  /** A leading fenced block exists and every non-empty line in it looks like YAML. */
  looksLikeYaml: boolean;
  /** Content between the fences, for the report excerpt. */
  body: string;
}

/**
 * Front matter is never removed on guesswork. With 'keep' the source is parsed as written and a leading
 * fenced block that looks like YAML only raises a warning (strict fails). With 'strip' the user has
 * declared that the document carries front matter, so the leading fenced block is removed and reported.
 */
function scanFrontMatter(source: string, mode: 'keep' | 'strip'): FrontMatterScan {
  const m = FENCE_RE.exec(source);
  if (!m) return { text: source, skippedLines: 0, looksLikeYaml: false, body: '' };
  const body = m[1] ?? '';
  const nonEmpty = body.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
  const looksLikeYaml = nonEmpty.length > 0 && nonEmpty.every((l) => YAML_LINE.test(l));
  if (mode === 'keep') return { text: source, skippedLines: 0, looksLikeYaml, body };
  const skippedLines = m[0].split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(m[0]) ? 1 : 0);
  return { text: source.slice(m[0].length), skippedLines, looksLikeYaml, body };
}

function collectDefinitions(tree: Root): Map<string, { url: string; title: string | null }> {
  const defs = new Map<string, { url: string; title: string | null }>();
  const visit = (node: Nodes) => {
    if (node.type === 'definition') {
      if (!defs.has(node.identifier)) defs.set(node.identifier, { url: node.url, title: node.title ?? null });
      return;
    }
    if ('children' in node) for (const c of (node as Parent).children) visit(c as Nodes);
  };
  visit(tree);
  return defs;
}

export function extractMarkdown(source: string, options: MarkdownExtractOptions = {}): Extraction {
  const mode = options.frontMatter ?? 'keep';
  const fm = scanFrontMatter(source, mode);
  const tree: Root = fromMarkdown(fm.text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const maxDepth = options.maxDepth ?? MAX_NESTING_DEPTH;
  const depth = treeDepth(tree);
  if (depth > maxDepth) throw new MarkdownExtractError(`Markdown nesting depth ${depth} exceeds the limit of ${maxDepth} levels; the comparison was not run.`);
  const ctx: Ctx = { base: options.baseUrl ?? null, source: fm.text, blocks: [], notes: [], issues: [], definitions: collectDefinitions(tree), listDepth: 0, maxDepth, wrappers: [] };
  const fmExcerpt = () => excerpt(fm.body.replace(/\s+/g, ' '));
  if (mode === 'strip' && fm.skippedLines > 0) {
    ctx.notes.push(`Front matter (${fm.skippedLines} lines) was stripped as requested (--front-matter strip).`);
    ctx.issues.push({ code: 'MARKDOWN_FRONT_MATTER_STRIPPED', severity: 'info', message: `Lines 1-${fm.skippedLines} were stripped as front matter (--front-matter strip) and not compared.`, line: 1, excerpt: fmExcerpt() });
  } else if (mode === 'strip') {
    ctx.notes.push('--front-matter strip was given but the document does not start with a fenced block; nothing was stripped.');
  } else if (fm.looksLikeYaml) {
    ctx.issues.push({ code: 'MARKDOWN_POSSIBLE_FRONT_MATTER', severity: 'warning', message: 'The document starts with a fenced block that looks like YAML front matter. It was compared as written (nothing is removed by default); pass --front-matter strip if it is metadata.', line: 1, excerpt: fmExcerpt() });
  }
  for (const child of tree.children) handle(ctx, child);
  if (fm.skippedLines > 0) {
    for (const b of ctx.blocks) if (b.location.line !== undefined) b.location.line += fm.skippedLines;
    for (const i of ctx.issues) if (i.code !== 'MARKDOWN_FRONT_MATTER_STRIPPED' && i.line !== undefined) i.line += fm.skippedLines;
  }
  return { blocks: ctx.blocks, strategy: 'markdown', confidence: 'high', notes: ctx.notes, issues: ctx.issues };
}
