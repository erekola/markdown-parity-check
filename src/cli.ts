#!/usr/bin/env node
// Command-line entry point. Exit codes: 0 no rejecting finding, 1 rejecting findings, 2 input, fetch,
// parse or report error that prevented a reliable comparison.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fetchUrl, FetchError, validateUrl, type FetchOptions, type FetchResult } from './fetch.js';
import { renderJson, renderText } from './report.js';
import { errorReport, run, RunError, type Report, type RunOptions, type SourceInput } from './run.js';
import { maskUrl, redactText } from './normalize.js';
import { TOOL_NAME, TOOL_VERSION } from './version.js';

export const HELP = `${TOOL_NAME} ${TOOL_VERSION}
Compares the main content of a web page's HTML and Markdown representations and reports concrete
missing, added and changed blocks.

Usage:
  ${TOOL_NAME} --url <https://example.com/page> [--markdown-url <url>] [options]
  ${TOOL_NAME} --html-file <page.html> --markdown-file <page.md> [--base-url <url>] [options]

Modes:
  --url <url>             Fetch <url> twice: with Accept: text/html and with Accept: text/markdown.
  --markdown-url <url>    Fetch the Markdown from this explicit address instead (requires --url).
  --html-file <path>      Offline: local HTML file (requires --markdown-file).
  --markdown-file <path>  Offline: local Markdown file (requires --html-file).
  --base-url <url>        Offline: base for resolving relative links on both sides.

Options:
  --html-profile generic|starlight
                          HTML extraction rules (default: generic). Starlight includes inactive tab panels.
  --selector <css>        CSS selector for the HTML main content (default: main, article, [role=main], then body).
  --front-matter keep|strip
                          Markdown front matter. keep (default) removes nothing and warns when the document
                          starts with a YAML-looking fenced block; strip removes that leading block.
  --format text|json      Report format (default: text).
  --output <path>         Write the report to a file instead of stdout. Refuses to overwrite an input file.
  --timeout-ms <n>        Per-fetch timeout in milliseconds (default: 15000).
  --max-bytes <n>         Cap on decoded response bytes per fetch (default: 5242880).
  --strict                Treat warnings as rejecting findings too.
  --help, -h              Show this help.
  --version, -V           Show the version.

Exit codes:
  0  comparison completed, no rejecting finding
  1  comparison completed, rejecting content or delivery differences found
  2  input, fetch, parse or report error prevented a reliable comparison

Only http(s) URLs to public addresses are fetched; loopback, private, link-local and other non-public
addresses are refused, also behind DNS and redirects. No JavaScript is executed. Exit 0 does not prove
semantic equivalence.
`;

export class CliError extends Error {}

/**
 * Whether the raw argv asks for JSON output, read directly because an argument error can be
 * thrown before parseCliArgs has produced a validated CliArgs (M-01, outside audit 2026-09-26).
 * Accepts both --format json and --format=json; the last occurrence wins, matching parseArgs.
 */
function rawWantsJson(argv: string[]): boolean {
  let wants = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--format') wants = argv[i + 1] === 'json';
    else if (a.startsWith('--format=')) wants = a.slice('--format='.length) === 'json';
  }
  return wants;
}

export interface CliArgs {
  htmlProfile: 'generic' | 'starlight';
  url?: string;
  markdownUrl?: string;
  htmlFile?: string;
  markdownFile?: string;
  baseUrl?: string;
  selector?: string;
  frontMatter: 'keep' | 'strip';
  format: 'text' | 'json';
  output?: string;
  timeoutMs: number;
  maxBytes: number;
  strict: boolean;
  help: boolean;
  version: boolean;
}

// The largest delay Node's own timer accepts (2^31 - 1 ms, about 24.8 days). A larger value is not
// rejected by Node: it becomes a roughly 1 ms timeout instead, with a TimeoutOverflowWarning, so an
// error built from the value the caller gave would misreport what is actually going to happen
// (P-N4, found by an outside review 2026-09-28).
const MAX_TIMEOUT_MS = 2147483647;

function positiveInt(name: string, raw: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined) return fallback;
  // maskUrl masks the whole value in one piece before it reaches a CliError message, unlike the generic
  // report redactor further down the pipeline (redactText), whose run-based URL detection splits at a raw
  // space inside the value and lets a fragment such as a password through unmasked (P-N3, found by an
  // outside review 2026-09-28); a CLI argument is attacker input the moment it is echoed back in an error,
  // whatever option it was given for.
  const shown = () => maskUrl(raw);
  if (!/^\d+$/.test(raw)) throw new CliError(`${name} must be a positive integer (got "${shown()}").`);
  const n = Number(raw);
  // A long enough run of digits overflows the IEEE 754 double to Infinity, which the old "> 0" check let
  // through unrejected; Number.isFinite closes that, and max rejects a value this option cannot actually
  // honor before it reaches the code that would silently reinterpret it (P-N4).
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new CliError(`${name} must be a positive integer, at most ${max} (got "${shown()}").`);
  return n;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        'html-profile': { type: 'string', default: 'generic' },
        url: { type: 'string' },
        'markdown-url': { type: 'string' },
        'html-file': { type: 'string' },
        'markdown-file': { type: 'string' },
        'base-url': { type: 'string' },
        selector: { type: 'string' },
        'front-matter': { type: 'string', default: 'keep' },
        format: { type: 'string', default: 'text' },
        output: { type: 'string' },
        'timeout-ms': { type: 'string' },
        'max-bytes': { type: 'string' },
        strict: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'V', default: false },
      },
    });
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  const v = parsed.values;
  const htmlProfile = v['html-profile'];
  if (htmlProfile !== 'generic' && htmlProfile !== 'starlight') throw new CliError('--html-profile must be generic or starlight.');
  const format = v.format;
  if (format !== 'text' && format !== 'json') throw new CliError(`--format must be text or json (got "${format}").`);
  const frontMatter = v['front-matter'];
  if (frontMatter !== 'keep' && frontMatter !== 'strip') throw new CliError(`--front-matter must be keep or strip (got "${frontMatter}").`);
  const args: CliArgs = {
    htmlProfile,
    url: v.url,
    markdownUrl: v['markdown-url'],
    htmlFile: v['html-file'],
    markdownFile: v['markdown-file'],
    baseUrl: v['base-url'],
    selector: v.selector,
    frontMatter,
    format,
    output: v.output,
    timeoutMs: positiveInt('--timeout-ms', v['timeout-ms'], 15000, MAX_TIMEOUT_MS),
    maxBytes: positiveInt('--max-bytes', v['max-bytes'], 5 * 1024 * 1024),
    strict: v.strict ?? false,
    help: v.help ?? false,
    version: v.version ?? false,
  };
  if (args.help || args.version) return args;

  const urlMode = args.url !== undefined || args.markdownUrl !== undefined;
  const fileMode = args.htmlFile !== undefined || args.markdownFile !== undefined;
  if (urlMode && fileMode) throw new CliError('Choose one mode: --url (with optional --markdown-url) or --html-file with --markdown-file.');
  if (!urlMode && !fileMode) throw new CliError('Missing input. Give --url <url>, or --html-file <path> with --markdown-file <path>. See --help.');
  if (urlMode) {
    if (args.url === undefined) throw new CliError('--markdown-url requires --url.');
    if (args.baseUrl !== undefined) throw new CliError('--base-url applies to the offline mode only; in URL mode links resolve against the fetched URLs.');
    validateUrl(args.url);
    if (args.markdownUrl !== undefined) validateUrl(args.markdownUrl);
  } else {
    if (args.htmlFile === undefined || args.markdownFile === undefined) throw new CliError('Offline mode needs both --html-file and --markdown-file.');
    if (args.baseUrl !== undefined) {
      try {
        const u = new URL(args.baseUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
      } catch {
        // args.baseUrl is embedded directly, so it must be masked here rather than left to the generic
        // redactText pass over stderr/JSON: a raw space breaks that pass's run-based URL detection into
        // fragments too small to recognize as one URL, leaving user information such as a password visible
        // (0.2.16, found by an outside review 2026-09-28). maskUrl handles the whole value correctly regardless.
        throw new CliError(`--base-url must be an absolute http(s) URL (got "${maskUrl(args.baseUrl)}").`);
      }
    }
  }
  if (args.selector !== undefined && args.selector.trim() === '') throw new CliError('--selector must not be empty.');
  if (args.output !== undefined) {
    const out = path.resolve(args.output);
    for (const input of [args.htmlFile, args.markdownFile]) {
      if (input !== undefined && (samePath(out, path.resolve(input)) || sameFile(out, path.resolve(input)))) throw new CliError(`--output must not point at an input file (${args.output}).`);
    }
  }
  return args;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return p;
    }
  };
  const x = norm(a);
  const y = norm(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Whether two existing paths name the same file, by device and file number. A hard link is a second name for the
 * same file and passes samePath, so up to 0.2.11 --output through a hard link overwrote the input with the report
 * (found by an outside review 2026-09-26). On Windows the file number is the NTFS file index; a file system that
 * reports 0 gives no answer, and samePath and the write through a temporary file below still apply.
 */
function sameFile(a: string, b: string): boolean {
  try {
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    return x.ino !== BigInt(0) && x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

function readFileInput(file: string, base: string | null): SourceInput {
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(`Cannot read ${file}: ${(err as NodeJS.ErrnoException).message}`);
  }
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  return { meta: { kind: 'file', file, bytes: Buffer.byteLength(body, 'utf8'), baseUrl: base ? maskUrl(base) : null }, body, base };
}

export type FetchFn = (url: string, options: FetchOptions) => Promise<FetchResult>;

async function fetchInput(url: string, accept: string, args: CliArgs, fetchFn: FetchFn): Promise<SourceInput> {
  const res = await fetchFn(url, { accept, timeoutMs: args.timeoutMs, maxBytes: args.maxBytes });
  return {
    meta: { kind: 'url', url: maskUrl(res.finalUrl), requestedUrl: maskUrl(url), status: res.status, contentType: res.contentType, accept, redirects: res.redirects, bytes: res.bytes, baseUrl: maskUrl(res.finalUrl) },
    body: res.body,
    base: res.finalUrl,
  };
}

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

function emit(report: Report, args: CliArgs, io: CliIo): void {
  const text = args.format === 'json' ? renderJson(report) : renderText(report);
  if (args.output === undefined) {
    io.stdout(text);
    return;
  }
  // The report goes to a new file next to the target, which then replaces the target by name. Writing into the
  // target would truncate whatever file it names, also an input reached through a link (0.2.12).
  const target = path.resolve(args.output);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, target);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing more to do: the error below names the target.
    }
    throw new CliError(`Cannot write report to ${args.output}: ${(err as NodeJS.ErrnoException).message}`);
  }
  io.stderr(`Report written to ${args.output} (${report.summary.result.toUpperCase()}, exit ${report.summary.exitCode}).\n`);
}

export interface CliDeps {
  /** Injectable fetch for tests. Production always uses fetchUrl with its default address policy. */
  fetch?: FetchFn;
}

/** Runs the CLI and returns the exit code. Throws nothing; every failure becomes exit 2. */
export async function main(argv: string[], io: CliIo = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }, deps: CliDeps = {}): Promise<0 | 1 | 2> {
  const fetchFn: FetchFn = deps.fetch ?? fetchUrl;
  // Everything written to stderr goes through the same masking as the report. An error can repeat a URL the user
  // gave or a header a server sent, and up to 0.2.11 stderr printed both as they were (found by an outside review
  // 2026-09-26).
  const raw = io;
  io = { stdout: raw.stdout, stderr: (s) => raw.stderr(redactText(s)) };
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    const message = (err as Error).message;
    // Argument validation fails before args.format is known, so a request for JSON is read from
    // the raw argv instead (M-01). The error report shape and exit code match a runtime failure;
    // stdout carries the report on top of, not instead of, the plain-text stderr line every
    // argument error writes, since --output cannot be trusted without validated args and callers
    // already rely on the stderr line regardless of format (test/review-0212.test.ts, test/secrets.test.ts).
    if (rawWantsJson(argv)) {
      const report = errorReport({ strict: false, mode: 'offline' }, null, null, message);
      io.stdout(renderJson(report));
    }
    io.stderr(`Error: ${message}\n`);
    return 2;
  }
  if (args.help) {
    io.stdout(HELP);
    return 0;
  }
  if (args.version) {
    io.stdout(`${TOOL_VERSION}\n`);
    return 0;
  }
  const options: RunOptions = { htmlProfile: args.htmlProfile, selector: args.selector, frontMatter: args.frontMatter, strict: args.strict, mode: args.url !== undefined ? 'url' : 'offline' };
  let html: SourceInput | null = null;
  let markdown: SourceInput | null = null;
  let report: Report;
  try {
    if (args.url !== undefined) {
      html = await fetchInput(args.url, 'text/html', args, fetchFn);
      if (html.meta.status !== undefined && html.meta.status >= 400) {
        throw new CliError(`The HTML request returned HTTP ${html.meta.status}; there is no page to compare.`);
      }
      markdown = await fetchInput(args.markdownUrl ?? args.url, 'text/markdown', args, fetchFn);
    } else {
      const base = args.baseUrl ?? null;
      html = readFileInput(args.htmlFile!, base);
      markdown = readFileInput(args.markdownFile!, base);
    }
    report = run(html, markdown, options);
  } catch (err) {
    let message: string;
    let value: string | undefined;
    if (err instanceof FetchError) message = `Fetch failed (${err.kind}) for ${err.url}: ${err.message}`;
    else if (err instanceof CliError) message = err.message;
    else if (err instanceof RunError) {
      message = err.message;
      value = err.value;
    } else message = `Unexpected error: ${(err as Error).stack ?? String(err)}`;
    report = errorReport(options, html?.meta ?? null, markdown?.meta ?? null, message, value);
    try {
      emit(report, args, io);
    } catch (e2) {
      // The report itself could not be written (P-N5, found by an outside review 2026-09-28): up to here
      // this fell through to a plain stderr line only, even under --format json, unlike every other error
      // path in this function, which puts a JSON report on stdout too when JSON was asked for.
      const writeMessage = (e2 as Error).message;
      if (args.format === 'json') io.stdout(renderJson(errorReport(options, html?.meta ?? null, markdown?.meta ?? null, writeMessage)));
      io.stderr(`Error: ${writeMessage}\n`);
    }
    io.stderr(`Error: ${message}\n`);
    return 2;
  }
  try {
    emit(report, args, io);
  } catch (err) {
    // Same P-N5 fallback as the error path above: a write failure got only a plain stderr line before,
    // even under --format json.
    const writeMessage = (err as Error).message;
    if (args.format === 'json') io.stdout(renderJson(errorReport(options, html?.meta ?? null, markdown?.meta ?? null, writeMessage)));
    io.stderr(`Error: ${writeMessage}\n`);
    return 2;
  }
  return report.summary.exitCode;
}

const invokedDirectly = process.argv[1] !== undefined && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
