// The comparison core: aligns blocks and turns the alignment into findings. Pure and network-free.

import { align, resolveLimits, AlignmentLimitError, UNCERTAIN_THRESHOLD, type AlignmentLimits, type Pair } from './align.js';
import type { Block, Extraction, Finding, FindingSide, Link } from './model.js';
import { excerpt, hrefDifference, looseNormalize, maskHref, redactText, relativeHrefRelation, visibleNumbers } from './normalize.js';

export interface Coverage {
  htmlBlocks: number;
  markdownBlocks: number;
  htmlMatched: number;
  markdownMatched: number;
  /** Matched share of HTML blocks, 0..1. */
  htmlRatio: number;
  markdownRatio: number;
}

export interface CompareResult {
  findings: Finding[];
  coverage: Coverage;
}

// The excerpt masks the whole block text before it cuts it, so it is computed once per block. Up to 0.2.11 every
// finding computed it again, and a block with thousands of link findings did that thousands of times (0.2.12).
const sides = new WeakMap<Block, FindingSide>();

function side(b: Block): FindingSide {
  let s = sides.get(b);
  if (!s) {
    s = { line: b.location.line, path: b.location.path, blockIndex: b.location.blockIndex, excerpt: excerpt(b.type === 'code' ? (b.code ?? b.text) : b.text) };
    sides.set(b, s);
  }
  return { ...s };
}

function label(b: Block): string {
  switch (b.type) {
    case 'heading':
      return `heading (h${b.depth ?? '?'})`;
    case 'listItem':
      return 'list item';
    case 'code':
      return 'code block';
    default:
      return b.type;
  }
}

/** The values of a that b does not account for, one for one, in the order of a. */
function unmatched(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const v of b) left.set(v, (left.get(v) ?? 0) + 1);
  const out: string[] = [];
  for (const v of a) {
    const n = left.get(v) ?? 0;
    if (n > 0) left.set(v, n - 1);
    else out.push(v);
  }
  return out;
}

/**
 * The numbers each side has that the other lacks, or both lists when the multisets are equal and only the order
 * differs; null when the lists are equal. Counted with a map: up to 0.2.11 every value was looked up with indexOf
 * and removed with splice, so one block with 20 000 numbers took two seconds (found by an outside review
 * 2026-09-26). The result is the same.
 * @internal Exported for test/compare-links.test.ts.
 */
export function diffNumbers(a: string[], b: string[]): { before: string[]; after: string[] } | null {
  if (a.length === b.length && a.every((v, i) => v === b[i])) return null;
  const before = unmatched(a, b);
  const after = unmatched(b, a);
  if (before.length === 0 && after.length === 0) return { before: a, after: b }; // same multiset, different order
  return { before, after };
}

// What a finding shows of a link. A link GFM made out of a hidden part of a URL shows neither text nor target.
const linkText = (l: Link, other?: Link) => (l.masked || other?.masked ? '***' : redactText(l.text));
const linkHref = (l: Link, href: string) => (l.masked ? '***' : maskHref(href));

/**
 * Pairs the HTML block's links with the Markdown block's, in three steps.
 *
 * 1. Links whose text occurs equally often on both sides pair in document order: the first "download" with the
 * first "download". Up to 0.2.12 every link took any unused link with the same text and target, so two links with
 * the same text and swapped targets passed with no finding (0.2.13, found by an outside review 2026-09-26).
 * 2. Every other link takes the first unused Markdown link, in document order, that has the same text and the same
 * target, or else the first unused one with the same text. The Markdown links are indexed by text and, for a
 * resolved HTML link, by text and target; an unresolved HTML link scans the links that share its text, because
 * relativeHrefRelation compares two references and has no key of its own (0.2.12, where the old scans of the
 * whole list made one block with 20 000 links take more than a second).
 * 3. What is still unpaired pairs by loosely normalized text, the same way as step 1 and then in order, so a link
 * whose text differs only in case or punctuation is one changed text and not a missing and an added link (0.2.13).
 * @internal Exported for test/compare-links.test.ts.
 */
export function pairLinks(hLinks: Link[], mLinks: Link[], maxWork = Number.POSITIVE_INFINITY): { pairs: Array<[number, number]>; missing: number[]; added: number[] } {
  const used = new Array<boolean>(mLinks.length).fill(false);
  const lists = new Map<string, number[]>();
  const heads = new Map<string, number>();
  const key = (...parts: string[]) => JSON.stringify(parts);
  const add = (k: string, i: number) => {
    const list = lists.get(k);
    if (list) list.push(i);
    else lists.set(k, [i]);
  };
  const first = (k: string): number => {
    const list = lists.get(k);
    if (!list) return -1;
    let n = heads.get(k) ?? 0;
    while (n < list.length && used[list[n]!]) n++;
    heads.set(k, n);
    return n < list.length ? list[n]! : -1;
  };
  mLinks.forEach((l, i) => {
    add(key('text', l.text), i);
    if (l.resolved !== null) add(key('resolved', l.text, l.resolved), i);
    else add(key('raw-unresolved', l.text, l.rawHref.trim()), i);
  });
  const count = (links: Link[]) => {
    const m = new Map<string, number>();
    for (const l of links) m.set(l.text, (m.get(l.text) ?? 0) + 1);
    return m;
  };
  const hCount = count(hLinks);
  const mCount = count(mLinks);
  const seenInH = new Map<string, number>();
  const pairs: Array<[number, number]> = [];
  let missing: number[] = [];
  // Unresolved links with the same text and unequal counts scan the shared list below once per HTML link (step
  // 2); work counts those scans so maxWork bounds the total the way maxSimilarityWork bounds align's own
  // similarity search (0.2.16, found by an outside review 2026-09-28).
  let work = 0;
  hLinks.forEach((hl, hi) => {
    let idx = -1;
    const k = seenInH.get(hl.text) ?? 0;
    seenInH.set(hl.text, k + 1);
    if (hCount.get(hl.text) === mCount.get(hl.text)) {
      idx = lists.get(key('text', hl.text))![k]!;
    } else if (hl.resolved !== null) {
      // sameTarget: a resolved Markdown link with the same resolved href, or an unresolved one with the same raw href.
      const a = first(key('resolved', hl.text, hl.resolved));
      const b = first(key('raw-unresolved', hl.text, hl.rawHref.trim()));
      idx = a < 0 ? b : b < 0 ? a : Math.min(a, b);
    } else {
      const list = lists.get(key('text', hl.text)) ?? [];
      for (const i of list) {
        work++;
        if (work > maxWork) {
          throw new AlignmentLimitError(`Comparison limit exceeded: pairing unresolved links by shared text needs more than ${maxWork} comparisons among ${hLinks.length} HTML and ${mLinks.length} Markdown links. Narrow the HTML content with --selector or compare a smaller page.`);
        }
        if (!used[i] && sameTarget(hl, mLinks[i]!)) {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) idx = first(key('text', hl.text));
    if (idx < 0) {
      missing.push(hi);
      return;
    }
    used[idx] = true;
    pairs.push([hi, idx]);
  });
  // Step 3: the links still unpaired, by loosely normalized text.
  const looseLists = new Map<string, number[]>();
  used.forEach((u, i) => {
    const k = u ? '' : looseNormalize(mLinks[i]!.text);
    if (k === '') return;
    const list = looseLists.get(k);
    if (list) list.push(i);
    else looseLists.set(k, [i]);
  });
  const looseMissing = new Map<string, number>();
  for (const hi of missing) {
    const k = looseNormalize(hLinks[hi]!.text);
    if (k !== '') looseMissing.set(k, (looseMissing.get(k) ?? 0) + 1);
  }
  const looseHeads = new Map<string, number>();
  const stillMissing: number[] = [];
  for (const hi of missing) {
    const k = looseNormalize(hLinks[hi]!.text);
    const list = k === '' ? undefined : looseLists.get(k);
    const n = looseHeads.get(k) ?? 0;
    if (!list || n >= list.length) {
      stillMissing.push(hi);
      continue;
    }
    // Equal counts pair in order and unequal counts take the next in order, so both are the next unused link.
    looseHeads.set(k, n + 1);
    used[list[n]!] = true;
    pairs.push([hi, list[n]!]);
  }
  missing = stillMissing;
  pairs.sort((x, y) => x[0] - y[0]);
  const added: number[] = [];
  used.forEach((u, i) => {
    if (!u) added.push(i);
  });
  return { pairs, missing, added };
}

function compareLinks(out: Finding[], h: Block, m: Block, bothBases: boolean, maxSimilarityWork: number): void {
  // Link targets are compared unmasked; every value that reaches a finding goes through maskHref.
  const { pairs, missing, added } = pairLinks(h.links, m.links, maxSimilarityWork);
  const events: Array<{ hi: number; mi: number }> = [...pairs.map(([hi, mi]) => ({ hi, mi })), ...missing.map((hi) => ({ hi, mi: -1 }))].sort((x, y) => x.hi - y.hi);
  for (const { hi, mi } of events) {
    const hl = h.links[hi]!;
    if (mi < 0) {
      out.push({ code: 'LINK_MISSING', severity: 'error', direction: 'html_only', message: `Link "${linkText(hl)}" (${linkHref(hl, hl.rawHref)}) is in the HTML block but not in the Markdown block.`, html: side(h), markdown: side(m), before: linkHref(hl, hl.rawHref) });
      continue;
    }
    const ml = m.links[mi]!;
    if (sameTarget(hl, ml)) continue;
    const text = linkText(hl, ml);
    if (hl.resolved !== null && ml.resolved !== null) {
      const diff = hrefDifference(hl.resolved, ml.resolved);
      out.push({ code: 'LINK_TARGET_CHANGED', severity: 'error', direction: 'both', message: `Link "${text}" points to a different target (${diff} differs).`, html: side(h), markdown: side(m), before: linkHref(hl, hl.resolved), after: linkHref(ml, ml.resolved) });
    } else if (hl.resolved === null && ml.resolved === null && relativeHrefRelation(hl.rawHref, ml.rawHref) === 'uncertain') {
      // Neither side resolved and no base could be ruled out as making them meet. A textual difference
      // alone does not establish different destinations, so this is a warning and not an error.
      out.push({ code: 'LINK_UNVERIFIED', severity: 'warning', direction: 'both', message: `Link "${text}" differs textually and no base URL is known, so the two relative forms cannot be confirmed equal or different.`, html: side(h), markdown: side(m), before: linkHref(hl, hl.rawHref), after: linkHref(ml, ml.rawHref) });
    } else if (hl.resolved === null && ml.resolved === null) {
      // Neither side resolved, and relativeHrefRelation found a difference no base can remove.
      const diff = hrefDifference(hl.rawHref, ml.rawHref);
      out.push({ code: 'LINK_TARGET_CHANGED', severity: 'error', direction: 'both', message: `Link "${text}" points to a different relative target (${diff} differs).`, html: side(h), markdown: side(m), before: linkHref(hl, hl.rawHref), after: linkHref(ml, ml.rawHref) });
    } else {
      out.push({ code: 'LINK_UNVERIFIED', severity: 'warning', direction: 'both', message: bothBases ? `Link "${text}" could not be resolved on one side.` : `Link "${text}" differs textually and no base URL is known, so relative and absolute forms cannot be confirmed equal.`, html: side(h), markdown: side(m), before: linkHref(hl, hl.rawHref), after: linkHref(ml, ml.rawHref) });
    }
  }
  for (const mi of added) {
    const ml = m.links[mi]!;
    out.push({ code: 'LINK_ADDED', severity: 'error', direction: 'markdown_only', message: `Link "${linkText(ml)}" (${linkHref(ml, ml.rawHref)}) is in the Markdown block but not in the HTML block.`, html: side(h), markdown: side(m), after: linkHref(ml, ml.rawHref) });
  }
}

function sameTarget(a: Link, b: Link): boolean {
  if (a.resolved !== null && b.resolved !== null) return a.resolved === b.resolved;
  if (a.resolved === null && b.resolved === null) return relativeHrefRelation(a.rawHref, b.rawHref) === 'same';
  return a.rawHref.trim() === b.rawHref.trim();
}

/**
 * Where a list item sits in its list (0.2.13): the list kind and the nesting level are warnings, a changed item
 * number and a changed task state are errors, because the reader sees a different number or a different state.
 */
function compareListItems(out: Finding[], h: Block, m: Block): void {
  const a = h.list;
  const b = m.list;
  if (!a || !b) return;
  const kind = (o: boolean) => (o ? 'numbered' : 'bulleted');
  if (a.ordered !== b.ordered) {
    out.push({ code: 'LIST_KIND_CHANGED', severity: 'warning', direction: 'both', message: `The list item is in a ${kind(a.ordered)} list in the HTML and a ${kind(b.ordered)} list in the Markdown.`, html: side(h), markdown: side(m), before: kind(a.ordered), after: kind(b.ordered) });
  } else if (a.ordinal !== undefined && b.ordinal !== undefined && a.ordinal !== b.ordinal) {
    out.push({ code: 'LIST_NUMBER_CHANGED', severity: 'error', direction: 'both', message: `List item number differs: ${a.ordinal} in the HTML, ${b.ordinal} in the Markdown.`, html: side(h), markdown: side(m), before: String(a.ordinal), after: String(b.ordinal) });
  }
  if (a.depth !== b.depth) {
    out.push({ code: 'LIST_NESTING_CHANGED', severity: 'warning', direction: 'both', message: `List nesting level differs: level ${a.depth + 1} in the HTML, level ${b.depth + 1} in the Markdown.`, html: side(h), markdown: side(m), before: String(a.depth + 1), after: String(b.depth + 1) });
  }
  if (a.checked !== b.checked) {
    const state = (c: boolean | null) => (c === null ? 'no checkbox' : c ? 'checked' : 'unchecked');
    const one = a.checked === null || b.checked === null;
    out.push({ code: 'LIST_TASK_CHANGED', severity: one ? 'warning' : 'error', direction: 'both', message: `Task state differs: ${state(a.checked)} in the HTML, ${state(b.checked)} in the Markdown.`, html: side(h), markdown: side(m), before: state(a.checked), after: state(b.checked) });
  }
}

function compareTables(out: Finding[], h: Block, m: Block): void {
  // A spanned table already carries its one EXTRACTION_TABLE_SPAN_NOT_COMPARED issue from extraction; the cell
  // positions html.ts still filled in are not reliable, so no cell-by-cell finding is added here (0.2.16).
  if (h.spanned) return;
  const hc = h.cells ?? [];
  const mc = m.cells ?? [];
  const hCols = Math.max(0, ...hc.map((r) => r.length));
  const mCols = Math.max(0, ...mc.map((r) => r.length));
  if (hc.length !== mc.length || hCols !== mCols) {
    out.push({ code: 'TABLE_SHAPE_CHANGED', severity: 'error', direction: 'both', message: `Table shape differs: HTML ${hc.length}x${hCols}, Markdown ${mc.length}x${mCols} (rows x columns).`, html: side(h), markdown: side(m), before: `${hc.length}x${hCols}`, after: `${mc.length}x${mCols}` });
    return;
  }
  for (let r = 0; r < hc.length; r++) {
    for (let c = 0; c < hCols; c++) {
      const hv = hc[r]?.[c] ?? '';
      const mv = mc[r]?.[c] ?? '';
      if (hv !== mv) {
        out.push({ code: 'TABLE_CELL_CHANGED', severity: 'error', direction: 'both', message: `Table cell (row ${r + 1}, column ${c + 1}) differs.`, html: side(h), markdown: side(m), before: hv, after: mv });
      }
    }
  }
}

function comparePair(out: Finding[], p: Pair, h: Block, m: Block, bothBases: boolean, maxSimilarityWork: number): void {
  if (p.kind === 'moved') {
    out.push({ code: 'ORDER_CHANGED', severity: 'warning', direction: 'both', message: `The ${label(h)} appears in a different position in the Markdown.`, html: side(h), markdown: side(m) });
  }
  if (h.type !== m.type) {
    out.push({ code: 'STRUCTURE_CHANGED', severity: 'warning', direction: 'both', message: `Same text, different structure: ${label(h)} in HTML, ${label(m)} in Markdown.`, html: side(h), markdown: side(m), before: h.type, after: m.type });
  }
  if (h.type === 'heading' && m.type === 'heading' && h.depth !== m.depth) {
    out.push({ code: 'HEADING_LEVEL_CHANGED', severity: 'warning', direction: 'both', message: `Heading level differs: h${h.depth} in HTML, h${m.depth} in Markdown.`, html: side(h), markdown: side(m), before: `h${h.depth}`, after: `h${m.depth}` });
  }
  const sameShapeTable = h.type === 'table' && m.type === 'table' && (h.cells ?? []).length === (m.cells ?? []).length;
  if (p.kind === 'similar' && p.similarity < UNCERTAIN_THRESHOLD && !sameShapeTable) {
    out.push({ code: 'ALIGNMENT_UNCERTAIN', severity: 'warning', direction: 'both', message: `These blocks were aligned with ${(p.similarity * 100).toFixed(0)} % token similarity; the differences reported for this pair may be a rewrite rather than an edit.`, html: side(h), markdown: side(m) });
  }
  if (h.type === 'table' && m.type === 'table') {
    compareTables(out, h, m);
  } else if (h.type === 'code' && m.type === 'code') {
    const hc = h.code ?? '';
    const mc = m.code ?? '';
    if (hc !== mc) {
      if (h.text === m.text) out.push({ code: 'CODE_WHITESPACE_CHANGED', severity: 'warning', direction: 'both', message: 'Code block differs only in whitespace or indentation.', html: side(h), markdown: side(m) });
      else out.push({ code: 'TEXT_CHANGED', severity: 'error', direction: 'both', message: 'Code block content differs.', html: side(h), markdown: side(m), before: excerpt(hc), after: excerpt(mc) });
    }
  } else if (h.text !== m.text) {
    const nd = diffNumbers(h.numbers, m.numbers);
    if (nd) {
      // Block.numbers holds every numeric token, also one inside a URL's query value, fragment or user
      // information, so a change there is still a number change and the classification does not move. What the
      // finding shows is read again from the text with those parts taken out, because the report masks them and
      // a bare number is not recognisable as part of a URL at the reporting boundary (0.2.10).
      const shown = diffNumbers(visibleNumbers(h.text), visibleNumbers(m.text));
      if (shown) {
        out.push({ code: 'NUMBER_CHANGED', severity: 'error', direction: 'both', message: `Numeric value differs in the ${label(h)}: ${shown.before.join(', ') || '(none)'} in HTML, ${shown.after.join(', ') || '(none)'} in Markdown.`, html: side(h), markdown: side(m), before: shown.before.join(', '), after: shown.after.join(', ') });
      } else {
        out.push({ code: 'NUMBER_CHANGED', severity: 'error', direction: 'both', message: `Numeric value differs in the ${label(h)} inside a masked part of a URL (a query value, the fragment or user information), so the values are not shown.`, html: side(h), markdown: side(m) });
      }
    } else if (h.loose === m.loose) {
      out.push({ code: 'TEXT_MINOR_CHANGED', severity: 'warning', direction: 'both', message: `The ${label(h)} differs only in case, punctuation or typographic characters.`, html: side(h), markdown: side(m), before: excerpt(h.text), after: excerpt(m.text) });
    } else {
      out.push({ code: 'TEXT_CHANGED', severity: 'error', direction: 'both', message: `The ${label(h)} text differs.`, html: side(h), markdown: side(m), before: excerpt(h.text), after: excerpt(m.text) });
    }
  }
  if (h.type === 'listItem' && m.type === 'listItem') compareListItems(out, h, m);
  compareLinks(out, h, m, bothBases, maxSimilarityWork);
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

export function compare(html: Extraction, markdown: Extraction, options: { bothBases?: boolean; limits?: Partial<AlignmentLimits> } = {}): CompareResult {
  const a = html.blocks;
  const b = markdown.blocks;
  const lim = resolveLimits(options.limits);
  const al = align(a, b, options.limits);
  const findings: Finding[] = [];
  const bothBases = options.bothBases ?? false;

  if (html.confidence === 'low') {
    findings.push({ code: 'EXTRACTION_LOW_CONFIDENCE', severity: 'warning', direction: 'html_only', message: 'HTML main content was taken from <body> because no <main>, <article> or [role=main] element exists; page chrome may leak into the comparison. Use --selector to narrow it.' });
  }
  for (const i of html.issues) findings.push({ code: i.code, severity: i.severity, direction: 'html_only', message: i.message, html: { line: i.line, excerpt: i.excerpt } });
  for (const i of markdown.issues) findings.push({ code: i.code, severity: i.severity, direction: 'markdown_only', message: i.message, markdown: { line: i.line, excerpt: i.excerpt } });
  for (const p of al.pairs) comparePair(findings, p, a[p.a]!, b[p.b]!, bothBases, lim.maxSimilarityWork);
  for (const i of al.unmatchedA) {
    const h = a[i]!;
    findings.push({ code: 'BLOCK_MISSING', severity: 'error', direction: 'html_only', message: `The ${label(h)} is in the HTML but not in the Markdown.`, html: side(h), before: excerpt(h.type === 'code' ? (h.code ?? h.text) : h.text) });
  }
  for (const j of al.unmatchedB) {
    const m = b[j]!;
    findings.push({ code: 'BLOCK_ADDED', severity: 'error', direction: 'markdown_only', message: `The ${label(m)} is in the Markdown but not in the HTML.`, markdown: side(m), after: excerpt(m.type === 'code' ? (m.code ?? m.text) : m.text) });
  }

  // Deterministic order: by HTML position, then Markdown position, then severity, then code.
  findings.sort((x, y) => {
    const xa = x.html?.blockIndex ?? Number.MAX_SAFE_INTEGER;
    const ya = y.html?.blockIndex ?? Number.MAX_SAFE_INTEGER;
    if (xa !== ya) return xa - ya;
    const xb = x.markdown?.blockIndex ?? Number.MAX_SAFE_INTEGER;
    const yb = y.markdown?.blockIndex ?? Number.MAX_SAFE_INTEGER;
    if (xb !== yb) return xb - yb;
    const s = SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity];
    if (s !== 0) return s;
    return x.code < y.code ? -1 : x.code > y.code ? 1 : 0;
  });

  const coverage: Coverage = {
    htmlBlocks: a.length,
    markdownBlocks: b.length,
    htmlMatched: a.length - al.unmatchedA.length,
    markdownMatched: b.length - al.unmatchedB.length,
    htmlRatio: a.length === 0 ? 0 : (a.length - al.unmatchedA.length) / a.length,
    markdownRatio: b.length === 0 ? 0 : (b.length - al.unmatchedB.length) / b.length,
  };
  return { findings, coverage };
}
