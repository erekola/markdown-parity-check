// Orchestration: takes resolved inputs (already fetched or read), runs extraction and comparison, and
// builds the report object. No argument parsing and no I/O here.

import { compare, type Coverage } from './compare.js';
import { extractHtml, HtmlExtractError } from './html.js';
import { extractMarkdown } from './markdown.js';
import type { Extraction, Finding } from './model.js';
import { maskUrl } from './normalize.js';
import { TOOL_VERSION } from './version.js';

export interface SourceMeta {
  kind: 'url' | 'file';
  /** Masked final URL (query values hidden, fragment dropped). */
  url?: string;
  requestedUrl?: string;
  file?: string;
  status?: number;
  contentType?: string | null;
  accept?: string;
  redirects?: number;
  bytes: number;
  /** Masked base URL used for link resolution, when known. */
  baseUrl?: string | null;
}

export interface SourceInput {
  meta: SourceMeta;
  body: string;
  /** Unmasked base URL for link resolution; never written to the report. */
  base: string | null;
}

export interface RunOptions {
  selector?: string;
  /** Markdown front matter handling; 'keep' by default (nothing removed). */
  frontMatter?: 'keep' | 'strip';
  strict: boolean;
  mode: 'url' | 'offline';
}

export interface ExtractionMeta {
  strategy: string;
  confidence: 'high' | 'low';
  blockCount: number;
  notes: string[];
}

export interface Report {
  schemaVersion: 1;
  toolVersion: string;
  generatedAt: string;
  mode: 'url' | 'offline';
  sources: { html: SourceMeta; markdown: SourceMeta };
  extraction: { html: ExtractionMeta; markdown: ExtractionMeta } | null;
  summary: {
    result: 'pass' | 'fail' | 'error';
    strict: boolean;
    errors: number;
    warnings: number;
    infos: number;
    coverage: Coverage | null;
    exitCode: 0 | 1 | 2;
    /** Present when the comparison could not be completed reliably. */
    error?: string;
  };
  findings: Finding[];
  limitations: string[];
}

export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunError';
  }
}

export const LIMITATIONS = [
  'Exit 0 means no rejecting difference was found in the extracted blocks; it does not prove semantic equivalence or factual correctness.',
  'JavaScript is not executed. Content that a page renders client-side is compared as served.',
  'Only the main content is compared. Page chrome (navigation, banners, footers directly under body) is removed from the HTML on purpose.',
  'Findings are quantitative: a missing paragraph is reported as missing, not interpreted.',
];

function meta(e: Extraction): ExtractionMeta {
  return { strategy: e.strategy, confidence: e.confidence, blockCount: e.blocks.length, notes: e.notes };
}

/** Findings about how the Markdown was delivered, produced by the URL mode before extraction. */
export function deliveryFindings(md: SourceMeta, body: string): Finding[] {
  const out: Finding[] = [];
  if (md.kind !== 'url') return out;
  const ct = (md.contentType ?? '').toLowerCase();
  const type = ct.split(';')[0]!.trim();
  const looksHtml = /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(body);
  if (md.status !== undefined && md.status >= 400) {
    out.push({ code: 'DELIVERY_HTTP_ERROR', severity: 'error', direction: 'markdown_only', message: `The Markdown request returned HTTP ${md.status}; the error page is not treated as content.`, before: String(md.status) });
    return out;
  }
  if (type === 'text/html' || type === 'application/xhtml+xml' || looksHtml) {
    out.push({ code: 'DELIVERY_MARKDOWN_IS_HTML', severity: 'error', direction: 'markdown_only', message: `The request with Accept: text/markdown returned HTML (Content-Type ${md.contentType ?? 'missing'}); the site does not deliver a Markdown representation at this address.`, before: md.contentType ?? '' });
    return out;
  }
  if (type === 'text/markdown' || type === 'text/x-markdown') return out;
  if (type === 'text/plain') {
    out.push({ code: 'DELIVERY_CONTENT_TYPE_PLAIN', severity: 'warning', direction: 'markdown_only', message: 'The Markdown response is labelled text/plain rather than text/markdown.', before: md.contentType ?? '' });
    return out;
  }
  out.push({ code: 'DELIVERY_UNEXPECTED_CONTENT_TYPE', severity: 'error', direction: 'markdown_only', message: `The Markdown response has an unexpected Content-Type (${md.contentType ?? 'missing'}).`, before: md.contentType ?? '' });
  return out;
}

function count(findings: Finding[]) {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const f of findings) {
    if (f.severity === 'error') errors++;
    else if (f.severity === 'warning') warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}

function baseReport(options: RunOptions, html: SourceMeta, markdown: SourceMeta): Report {
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    sources: { html, markdown },
    extraction: null,
    summary: { result: 'error', strict: options.strict, errors: 0, warnings: 0, infos: 0, coverage: null, exitCode: 2 },
    findings: [],
    limitations: LIMITATIONS,
  };
}

export function run(html: SourceInput, markdown: SourceInput, options: RunOptions): Report {
  const report = baseReport(options, html.meta, markdown.meta);

  const delivery = deliveryFindings(markdown.meta, markdown.body);
  if (delivery.some((f) => f.severity === 'error')) {
    report.findings = delivery;
    const c = count(delivery);
    report.summary = { ...report.summary, ...c, result: 'fail', exitCode: 1 };
    return report;
  }

  let h: Extraction;
  try {
    h = extractHtml(html.body, { selector: options.selector, baseUrl: html.base });
  } catch (err) {
    if (err instanceof HtmlExtractError) throw new RunError(err.message);
    throw err;
  }
  const m = extractMarkdown(markdown.body, { baseUrl: markdown.base, frontMatter: options.frontMatter ?? 'keep' });
  report.extraction = { html: meta(h), markdown: meta(m) };
  if (h.blocks.length === 0) throw new RunError(`HTML main content is empty (strategy ${h.strategy}); nothing to compare.`);
  if (m.blocks.length === 0) throw new RunError('Markdown content is empty; nothing to compare.');

  const result = compare(h, m, { bothBases: html.base !== null && markdown.base !== null });
  const findings = [...delivery, ...result.findings];
  const c = count(findings);
  const failing = c.errors > 0 || (options.strict && c.warnings > 0);
  report.findings = findings;
  report.summary = { result: failing ? 'fail' : 'pass', strict: options.strict, ...c, coverage: result.coverage, exitCode: failing ? 1 : 0 };
  return report;
}

export function errorReport(options: RunOptions, html: SourceMeta | null, markdown: SourceMeta | null, message: string): Report {
  const empty: SourceMeta = { kind: options.mode === 'url' ? 'url' : 'file', bytes: 0 };
  const r = baseReport(options, html ?? empty, markdown ?? empty);
  r.summary.error = message;
  return r;
}

export { maskUrl };
