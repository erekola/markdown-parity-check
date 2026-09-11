// Markdown extraction into the shared block model, using mdast-util-from-markdown with GFM extensions.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes, Parent, PhrasingContent, Root, RootContent, Table } from 'mdast';
import type { Block, Extraction, ExtractionIssue, Link } from './model.js';
import { extractHtml, MAX_NESTING_DEPTH } from './html.js';
import { parseDocument } from 'htmlparser2';
import { Element, Text, type ChildNode } from 'domhandler';
import { excerpt, extractNumbers, looseNormalize, normalizeCode, resolveHref, strictNormalize } from './normalize.js';

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
  blocks: Block[];
  notes: string[];
  issues: ExtractionIssue[];
  /** Link reference definitions by normalized identifier (first definition wins, per CommonMark). */
  definitions: Map<string, { url: string; title: string | null }>;
}

interface InlineRun {
  text: string;
  links: Link[];
}

interface InlineTag {
  name: string;
  closing: boolean;
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
  if (!/^<[A-Za-z][^>]*>$/.test(v)) return null;
  const doc = parseDocument(v, { decodeEntities: true });
  const el = doc.children.find((c): c is Element => c instanceof Element);
  if (!el) return null;
  return { name: el.name.toLowerCase(), closing: false, attribs: el.attribs };
}

/**
 * Walks phrasing children in order so that inline HTML anchors (<a href="..">text</a>) become links with
 * their Markdown child text. Other inline tags are structure, not content: <img> contributes its alt
 * text, <br> a space, everything else is dropped while the text between tags stays.
 */
function inlineChildren(ctx: Ctx, children: PhrasingContent[], run: InlineRun, line?: number): void {
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    if (node.type !== 'html') {
      inline(ctx, node, run);
      continue;
    }
    const tag = parseInlineTag(node.value);
    if (!tag) continue; // comment or unparsable fragment: no visible content
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
      run.links.push({ text: strictNormalize(inner.text), rawHref: node.url, resolved: resolveHref(node.url, ctx.base) });
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
  ctx.blocks.push(block);
}

function handleTable(ctx: Ctx, table: Table): void {
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
  push(ctx, { type: 'table', text: strictNormalize(text), cells, links }, table);
}

function handle(ctx: Ctx, node: RootContent, listItem = false): void {
  switch (node.type) {
    case 'heading': {
      const run: InlineRun = { text: '', links: [] };
      inlineChildren(ctx, node.children, run, node.position?.start.line);
      const text = strictNormalize(run.text);
      if (text !== '') push(ctx, { type: 'heading', text, depth: node.depth, links: run.links }, node);
      return;
    }
    case 'paragraph': {
      const run: InlineRun = { text: '', links: [] };
      inlineChildren(ctx, node.children, run, node.position?.start.line);
      const text = strictNormalize(run.text);
      if (text !== '') push(ctx, { type: listItem ? 'listItem' : 'paragraph', text, links: run.links }, node);
      return;
    }
    case 'code': {
      const code = normalizeCode(node.value);
      if (code.trim() !== '') push(ctx, { type: 'code', text: strictNormalize(code), code, links: [] }, node);
      return;
    }
    case 'table':
      handleTable(ctx, node);
      return;
    case 'list':
      for (const item of node.children) {
        let first = true;
        for (const child of item.children) {
          handle(ctx, child, first && child.type === 'paragraph');
          first = false;
        }
        if (item.children.length === 0) continue;
      }
      return;
    case 'blockquote':
      for (const c of node.children) handle(ctx, c);
      return;
    case 'html':
      handleRawHtml(ctx, node.value, node.position?.start.line);
      return;
    case 'thematicBreak':
    case 'definition':
    case 'footnoteDefinition':
    case 'yaml':
      return;
    default:
      if ('children' in node) for (const c of (node as Parent).children) handle(ctx, c as RootContent);
  }
}

/** A raw HTML block in Markdown is parsed with the HTML extractor so its content takes part in the
 * comparison; the report shows that this happened. Comments and bare tags without text yield nothing. */
function handleRawHtml(ctx: Ctx, value: string, line: number | undefined): void {
  // Text check for the fallback warning, taken from the parsed DOM rather than from regex stripping:
  // comments are not text, and script, style, template and noscript are page machinery on both sides,
  // so their content does not count as skipped text.
  const textOnly = visibleText(value);
  let parsed: Extraction | null = null;
  try {
    parsed = extractHtml(`<body>${value}</body>`, { selector: 'body', baseUrl: ctx.base });
  } catch {
    parsed = null;
  }
  const blocks = parsed?.blocks ?? [];
  if (blocks.length > 0) {
    for (const b of blocks) {
      // The wrapper <body> sits on the fragment's first line, so the extractor's line is 1-based within
      // the fragment and maps onto the html node's start line.
      const inner = b.location.line;
      const absolute = line !== undefined && inner !== undefined ? line + inner - 1 : line;
      ctx.blocks.push({ ...b, location: { line: absolute, blockIndex: ctx.blocks.length } });
    }
    ctx.issues.push({ code: 'MARKDOWN_RAW_HTML_PARSED', severity: 'info', message: `A raw HTML block in the Markdown was parsed as HTML (${blocks.length} block(s)); Markdown readers that do not render HTML will not see it.`, line, excerpt: excerpt(textOnly) });
  } else if (textOnly !== '') {
    ctx.issues.push({ code: 'MARKDOWN_RAW_HTML_SKIPPED', severity: 'warning', message: 'A raw HTML block in the Markdown carries text that could not be parsed into blocks; it was not compared.', line, excerpt: excerpt(textOnly) });
  }
}

const MACHINERY = new Set(['script', 'style', 'template', 'noscript']);

/** Strictly normalized text of an HTML fragment as a parser sees it: text nodes only, comments and
 * machinery elements excluded. */
function visibleText(fragment: string): string {
  const parts: string[] = [];
  const walk = (nodes: ChildNode[]): void => {
    for (const node of nodes) {
      if (node instanceof Text) parts.push(node.data);
      else if (node instanceof Element) {
        if (MACHINERY.has(node.name.toLowerCase())) continue;
        walk(node.children);
      }
    }
  };
  walk(parseDocument(fragment).children);
  return strictNormalize(parts.join(' '));
}

const YAML_LINE = /^(?:[A-Za-z0-9_.-]+\s*:(?:\s|$)|\s+\S|-\s|#)/;
const FENCE_RE = /^(?:\ufeff)?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

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
  const nonEmpty = body.split(/\r?\n/).filter((l) => l.trim() !== '');
  const looksLikeYaml = nonEmpty.length > 0 && nonEmpty.every((l) => YAML_LINE.test(l));
  if (mode === 'keep') return { text: source, skippedLines: 0, looksLikeYaml, body };
  const skippedLines = m[0].split(/\r?\n/).length - (m[0].endsWith('\n') ? 1 : 0);
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
  const ctx: Ctx = { base: options.baseUrl ?? null, blocks: [], notes: [], issues: [], definitions: collectDefinitions(tree) };
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
