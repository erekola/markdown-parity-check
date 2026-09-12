// The comparison core: aligns blocks and turns the alignment into findings. Pure and network-free.

import { align, UNCERTAIN_THRESHOLD, type AlignmentLimits, type Pair } from './align.js';
import type { Block, Extraction, Finding, FindingSide, Link } from './model.js';
import { excerpt, hrefDifference, maskHref, redactText, relativeHrefRelation } from './normalize.js';

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

function side(b: Block): FindingSide {
  return { line: b.location.line, path: b.location.path, blockIndex: b.location.blockIndex, excerpt: excerpt(b.type === 'code' ? (b.code ?? b.text) : b.text) };
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

function diffNumbers(a: string[], b: string[]): { before: string[]; after: string[] } | null {
  if (a.length === b.length && a.every((v, i) => v === b[i])) return null;
  const remB = [...b];
  const before: string[] = [];
  for (const v of a) {
    const k = remB.indexOf(v);
    if (k >= 0) remB.splice(k, 1);
    else before.push(v);
  }
  const remA = [...a];
  const after: string[] = [];
  for (const v of b) {
    const k = remA.indexOf(v);
    if (k >= 0) remA.splice(k, 1);
    else after.push(v);
  }
  if (before.length === 0 && after.length === 0) return { before: a, after: b }; // same multiset, different order
  return { before, after };
}

function compareLinks(out: Finding[], h: Block, m: Block, bothBases: boolean): void {
  // Link targets are compared unmasked; every value that reaches a finding goes through maskHref.
  const remaining: Link[] = [...m.links];
  for (const hl of h.links) {
    let idx = remaining.findIndex((ml) => ml.text === hl.text && sameTarget(hl, ml));
    if (idx < 0) idx = remaining.findIndex((ml) => ml.text === hl.text);
    if (idx < 0) {
      out.push({ code: 'LINK_MISSING', severity: 'error', direction: 'html_only', message: `Link "${redactText(hl.text)}" (${maskHref(hl.rawHref)}) is in the HTML block but not in the Markdown block.`, html: side(h), markdown: side(m), before: maskHref(hl.rawHref) });
      continue;
    }
    const ml = remaining.splice(idx, 1)[0]!;
    if (sameTarget(hl, ml)) continue;
    if (hl.resolved !== null && ml.resolved !== null) {
      const diff = hrefDifference(hl.resolved, ml.resolved);
      out.push({ code: 'LINK_TARGET_CHANGED', severity: 'error', direction: 'both', message: `Link "${redactText(hl.text)}" points to a different target (${diff} differs).`, html: side(h), markdown: side(m), before: maskHref(hl.resolved), after: maskHref(ml.resolved) });
    } else if (hl.resolved === null && ml.resolved === null && relativeHrefRelation(hl.rawHref, ml.rawHref) === 'uncertain') {
      // Neither side resolved and no base could be ruled out as making them meet. A textual difference
      // alone does not establish different destinations, so this is a warning and not an error.
      out.push({ code: 'LINK_UNVERIFIED', severity: 'warning', direction: 'both', message: `Link "${redactText(hl.text)}" differs textually and no base URL is known, so the two relative forms cannot be confirmed equal or different.`, html: side(h), markdown: side(m), before: maskHref(hl.rawHref), after: maskHref(ml.rawHref) });
    } else if (hl.resolved === null && ml.resolved === null) {
      // Neither side resolved, and relativeHrefRelation found a difference no base can remove.
      const diff = hrefDifference(hl.rawHref, ml.rawHref);
      out.push({ code: 'LINK_TARGET_CHANGED', severity: 'error', direction: 'both', message: `Link "${redactText(hl.text)}" points to a different relative target (${diff} differs).`, html: side(h), markdown: side(m), before: maskHref(hl.rawHref), after: maskHref(ml.rawHref) });
    } else {
      out.push({ code: 'LINK_UNVERIFIED', severity: 'warning', direction: 'both', message: bothBases ? `Link "${redactText(hl.text)}" could not be resolved on one side.` : `Link "${redactText(hl.text)}" differs textually and no base URL is known, so relative and absolute forms cannot be confirmed equal.`, html: side(h), markdown: side(m), before: maskHref(hl.rawHref), after: maskHref(ml.rawHref) });
    }
  }
  for (const ml of remaining) {
    out.push({ code: 'LINK_ADDED', severity: 'error', direction: 'markdown_only', message: `Link "${redactText(ml.text)}" (${maskHref(ml.rawHref)}) is in the Markdown block but not in the HTML block.`, html: side(h), markdown: side(m), after: maskHref(ml.rawHref) });
  }
}

function sameTarget(a: Link, b: Link): boolean {
  if (a.resolved !== null && b.resolved !== null) return a.resolved === b.resolved;
  if (a.resolved === null && b.resolved === null) return relativeHrefRelation(a.rawHref, b.rawHref) === 'same';
  return a.rawHref.trim() === b.rawHref.trim();
}

function compareTables(out: Finding[], h: Block, m: Block): void {
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

function comparePair(out: Finding[], p: Pair, h: Block, m: Block, bothBases: boolean): void {
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
      out.push({ code: 'NUMBER_CHANGED', severity: 'error', direction: 'both', message: `Numeric value differs in the ${label(h)}: ${nd.before.join(', ') || '(none)'} in HTML, ${nd.after.join(', ') || '(none)'} in Markdown.`, html: side(h), markdown: side(m), before: nd.before.join(', '), after: nd.after.join(', ') });
    } else if (h.loose === m.loose) {
      out.push({ code: 'TEXT_MINOR_CHANGED', severity: 'warning', direction: 'both', message: `The ${label(h)} differs only in case, punctuation or typographic characters.`, html: side(h), markdown: side(m), before: excerpt(h.text), after: excerpt(m.text) });
    } else {
      out.push({ code: 'TEXT_CHANGED', severity: 'error', direction: 'both', message: `The ${label(h)} text differs.`, html: side(h), markdown: side(m), before: excerpt(h.text), after: excerpt(m.text) });
    }
  }
  compareLinks(out, h, m, bothBases);
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

export function compare(html: Extraction, markdown: Extraction, options: { bothBases?: boolean; limits?: Partial<AlignmentLimits> } = {}): CompareResult {
  const a = html.blocks;
  const b = markdown.blocks;
  const al = align(a, b, options.limits);
  const findings: Finding[] = [];
  const bothBases = options.bothBases ?? false;

  if (html.confidence === 'low') {
    findings.push({ code: 'EXTRACTION_LOW_CONFIDENCE', severity: 'warning', direction: 'html_only', message: 'HTML main content was taken from <body> because no <main>, <article> or [role=main] element exists; page chrome may leak into the comparison. Use --selector to narrow it.' });
  }
  for (const i of html.issues) findings.push({ code: i.code, severity: i.severity, direction: 'html_only', message: i.message, html: { line: i.line, excerpt: i.excerpt } });
  for (const i of markdown.issues) findings.push({ code: i.code, severity: i.severity, direction: 'markdown_only', message: i.message, markdown: { line: i.line, excerpt: i.excerpt } });
  for (const p of al.pairs) comparePair(findings, p, a[p.a]!, b[p.b]!, bothBases);
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
