// Report rendering: human-readable text and JSON. No ANSI colours anywhere.

import type { Finding } from './model.js';
import type { Report, SourceMeta } from './run.js';
import { TOOL_NAME } from './version.js';
import { redactText } from './normalize.js';

/** Reporting boundary: every string that leaves the tool goes through redactText. Internal comparison
 * has already happened on the original values. */
export function redactReport(report: Report): Report {
  return mapStrings(report, redactText);
}

/** A copy of the value with fn applied to every string in it, however deep. */
function mapStrings<T>(value: T, fn: (s: string) => string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fn(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** A value that came from a page or from an argument stays on its own line of the text report. A line feed or a
 * carriage return in a link target, which an attribute can write as &#10; or &#13;, started a line that looked like a
 * finding (0.2.39, found by an outside review 2026-11-14). The break is shown as \n or \r, the way JSON shows it. */
function oneLine(s: string): string {
  return s.replace(/[\r\n]/g, (c) => (c === '\n' ? '\\n' : '\\r'));
}

export function renderJson(input: Report): string {
  return JSON.stringify(redactReport(input), null, 2) + '\n';
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

function source(label: string, s: SourceMeta): string {
  if (s.kind === 'url') {
    const parts = [`HTTP ${s.status ?? '?'}`, s.contentType ?? 'no content-type', `Accept: ${s.accept ?? '?'}`, `${s.redirects ?? 0} redirect(s)`, `${fmtInt(s.bytes)} bytes`];
    return `${label} ${s.url ?? '?'} (${parts.join(', ')})`;
  }
  return `${label} ${s.file ?? '?'} (file, ${fmtInt(s.bytes)} bytes${s.baseUrl ? `, base ${s.baseUrl}` : ''})`;
}

function findingLines(i: number, f: Finding): string[] {
  const lines = [`${String(i).padStart(3)}. [${f.severity}] ${f.code}: ${f.message}`];
  if (f.html) {
    const loc = [f.html.line !== undefined ? `line ${f.html.line}` : null, f.html.path ?? null, f.html.blockIndex !== undefined ? `block #${f.html.blockIndex}` : null].filter(Boolean).join(', ');
    lines.push(`       HTML      ${loc}${f.html.excerpt !== undefined ? `  "${f.html.excerpt}"` : ''}`);
  }
  if (f.markdown) {
    const loc = [f.markdown.line !== undefined ? `line ${f.markdown.line}` : null, f.markdown.blockIndex !== undefined ? `block #${f.markdown.blockIndex}` : null].filter(Boolean).join(', ');
    lines.push(`       Markdown  ${loc}${f.markdown.excerpt !== undefined ? `  "${f.markdown.excerpt}"` : ''}`);
  }
  if (f.before !== undefined || f.after !== undefined) {
    lines.push(`       before: ${f.before ?? '(none)'}`);
    lines.push(`       after:  ${f.after ?? '(none)'}`);
  }
  return lines;
}

export function renderText(input: Report): string {
  const report = mapStrings(redactReport(input), oneLine);
  const out: string[] = [];
  const s = report.summary;
  out.push(`${TOOL_NAME} ${report.toolVersion} (${report.mode} mode${s.strict ? ', strict' : ''})`);
  if (s.result === 'error') {
    // errorValue (V10-P3-01) is the specific input value the message names, already capped where it was
    // built; shown as its own labelled part rather than folded back into the sentence.
    out.push(`Result: ERROR. ${s.error ?? 'The comparison could not be completed.'}${s.errorValue !== undefined ? ` (value: "${s.errorValue}")` : ''}`);
  } else {
    out.push(`Result: ${s.result.toUpperCase()} (${s.errors} error(s), ${s.warnings} warning(s), ${s.infos} info)`);
  }
  out.push('');
  out.push(source('HTML:    ', report.sources.html));
  out.push(source('Markdown:', report.sources.markdown));
  if (report.extraction) {
    const e = report.extraction;
    out.push(`Extraction: HTML via ${e.html.strategy} (${e.html.confidence} confidence), ${e.html.blockCount} block(s); Markdown ${e.markdown.blockCount} block(s).`);
    for (const n of [...e.html.notes, ...e.markdown.notes]) out.push(`  note: ${n}`);
  }
  if (s.coverage) {
    const c = s.coverage;
    out.push(`Coverage: ${c.htmlMatched}/${c.htmlBlocks} HTML block(s) aligned (${(c.htmlRatio * 100).toFixed(0)} %), ${c.markdownMatched}/${c.markdownBlocks} Markdown block(s) aligned (${(c.markdownRatio * 100).toFixed(0)} %).`);
  }
  out.push('');
  if (report.findings.length === 0) {
    out.push(s.result === 'error' ? 'No findings (comparison not completed).' : 'No findings.');
  } else {
    out.push(`Findings (${report.findings.length}):`);
    report.findings.forEach((f, i) => out.push(...findingLines(i + 1, f)));
  }
  out.push('');
  out.push('Limitations:');
  for (const l of report.limitations) out.push(`  - ${l}`);
  return out.join('\n') + '\n';
}
