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
import { maskUrl } from './normalize.js';
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

export interface CliArgs {
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

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new CliError(`${name} must be a positive integer (got "${raw}").`);
  return Number(raw);
}

export function parseCliArgs(argv: string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
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
  const format = v.format;
  if (format !== 'text' && format !== 'json') throw new CliError(`--format must be text or json (got "${format}").`);
  const frontMatter = v['front-matter'];
  if (frontMatter !== 'keep' && frontMatter !== 'strip') throw new CliError(`--front-matter must be keep or strip (got "${frontMatter}").`);
  const args: CliArgs = {
    url: v.url,
    markdownUrl: v['markdown-url'],
    htmlFile: v['html-file'],
    markdownFile: v['markdown-file'],
    baseUrl: v['base-url'],
    selector: v.selector,
    frontMatter,
    format,
    output: v.output,
    timeoutMs: positiveInt('--timeout-ms', v['timeout-ms'], 15000),
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
        throw new CliError(`--base-url must be an absolute http(s) URL (got "${args.baseUrl}").`);
      }
    }
  }
  if (args.selector !== undefined && args.selector.trim() === '') throw new CliError('--selector must not be empty.');
  if (args.output !== undefined) {
    const out = path.resolve(args.output);
    for (const input of [args.htmlFile, args.markdownFile]) {
      if (input !== undefined && samePath(out, path.resolve(input))) throw new CliError(`--output must not point at an input file (${args.output}).`);
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
  try {
    fs.writeFileSync(args.output, text, { encoding: 'utf8' });
  } catch (err) {
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
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    io.stderr(`Error: ${(err as Error).message}\n`);
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
  const options: RunOptions = { selector: args.selector, frontMatter: args.frontMatter, strict: args.strict, mode: args.url !== undefined ? 'url' : 'offline' };
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
    if (err instanceof FetchError) message = `Fetch failed (${err.kind}) for ${err.url}: ${err.message}`;
    else if (err instanceof CliError || err instanceof RunError) message = err.message;
    else message = `Unexpected error: ${(err as Error).stack ?? String(err)}`;
    report = errorReport(options, html?.meta ?? null, markdown?.meta ?? null, message);
    try {
      emit(report, args, io);
    } catch (e2) {
      io.stderr(`Error: ${(e2 as Error).message}\n`);
    }
    io.stderr(`Error: ${message}\n`);
    return 2;
  }
  try {
    emit(report, args, io);
  } catch (err) {
    io.stderr(`Error: ${(err as Error).message}\n`);
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
