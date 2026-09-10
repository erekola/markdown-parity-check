import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { main, parseCliArgs, CliError } from '../src/cli.js';
import { fetchUrl } from '../src/fetch.js';
import type { Report } from '../src/run.js';
import { CLI, FIXTURES, ROOT } from './helpers.js';
import { startHarness, type Harness } from './harness.js';

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const fx = (name: string) => ['--html-file', path.join(FIXTURES, name, 'page.html'), '--markdown-file', path.join(FIXTURES, name, 'page.md'), ...(name === 'same' ? ['--front-matter', 'strip'] : [])];

let tmp: string;
before(() => {
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  tmp = fs.mkdtempSync(path.join(ROOT, '.tmp', 'cli-'));
});
after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // A sandbox without delete permission leaves the temp folder behind; that is not a test failure.
  }
});

describe('argument validation', () => {
  it('rejects missing, conflicting and malformed arguments with exit 2', () => {
    assert.equal(cli([]).code, 2);
    assert.match(cli([]).err, /Missing input/);
    assert.match(cli(['--url', 'https://example.com', '--html-file', 'x']).err, /Choose one mode/);
    assert.match(cli(['--markdown-url', 'https://example.com/x.md']).err, /requires --url/);
    assert.match(cli(['--html-file', 'x.html']).err, /both --html-file and --markdown-file/);
    assert.match(cli(['--url', 'ftp://example.com']).err, /Only http and https/);
    assert.match(cli(['--url', 'https://example.com', '--base-url', 'https://x']).err, /offline mode only/);
    assert.match(cli([...fx('same'), '--format', 'xml']).err, /--format must be/);
    assert.match(cli([...fx('same'), '--timeout-ms=0']).err, /positive integer/);
    assert.match(cli([...fx('same'), '--max-bytes', 'abc']).err, /positive integer/);
    assert.match(cli([...fx('same'), '--base-url', 'notaurl']).err, /--base-url must be/);
    assert.match(cli([...fx('same'), '--bogus']).err, /Unknown option/);
    assert.match(cli([...fx('numbers'), '--front-matter', 'auto']).err, /--front-matter must be keep or strip/);
    assert.match(cli([...fx('same'), 'extra']).err, /Unexpected argument/);
  });
  it('refuses --output that points at an input file', () => {
    const r = cli([...fx('same'), '--output', path.join(FIXTURES, 'same', 'page.md')]);
    assert.equal(r.code, 2);
    assert.match(r.err, /must not point at an input file/);
    assert.equal(fs.readFileSync(path.join(FIXTURES, 'same', 'page.md'), 'utf8').startsWith('---'), true);
  });
  it('parseCliArgs throws CliError', () => {
    assert.throws(() => parseCliArgs([]), CliError);
  });
  it('--help and --version', () => {
    const h = cli(['--help']);
    assert.equal(h.code, 0);
    assert.match(h.out, /Usage:/);
    const v = cli(['--version']);
    assert.equal(v.code, 0);
    assert.match(v.out, /^\d+\.\d+\.\d+\n$/);
  });
});

describe('offline mode through the real CLI', () => {
  it('exit 0 and PASS for the same-content pair', () => {
    const r = cli([...fx('same'), '--base-url', 'https://example.com/page']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Result: PASS \(0 error\(s\), 0 warning\(s\), 1 info\)/);
    assert.match(r.out, /MARKDOWN_FRONT_MATTER_STRIPPED/);
    const keep = cli(['--html-file', path.join(FIXTURES, 'same', 'page.html'), '--markdown-file', path.join(FIXTURES, 'same', 'page.md'), '--base-url', 'https://example.com/page']);
    assert.equal(keep.code, 1, 'by default the front matter is content and the pair differs');
    assert.match(keep.out, /MARKDOWN_POSSIBLE_FRONT_MATTER/);
    assert.match(r.out, /Coverage: 9\/9 HTML/);
  });
  it('exit 1 and locatable findings for a differing pair', () => {
    const r = cli([...fx('numbers')]);
    assert.equal(r.code, 1);
    assert.match(r.out, /Result: FAIL \(3 error\(s\)/);
    assert.match(r.out, /NUMBER_CHANGED/);
    assert.match(r.out, /HTML {6}line 4, main > p:nth-of-type\(1\), block #1/);
    assert.match(r.out, /Markdown {2}line 3, block #1/);
    assert.match(r.out, /before: 490€/);
    assert.doesNotMatch(r.out, /\[/, 'no ANSI colours');
  });
  it('--strict turns warnings into a failure', () => {
    assert.equal(cli([...fx('reorder')]).code, 0);
    assert.equal(cli([...fx('reorder'), '--strict']).code, 1);
  });
  it('exit 2 for empty main content and for a selector that does not match', () => {
    const e = cli([...fx('empty-main')]);
    assert.equal(e.code, 2);
    assert.match(e.err, /HTML main content is empty/);
    const s = cli([...fx('same'), '--selector', '#nope']);
    assert.equal(s.code, 2);
    assert.match(s.err, /matched no element/);
    const ok = cli([...fx('same'), '--selector', 'main', '--base-url', 'https://example.com/page']);
    assert.equal(ok.code, 0);
  });
  it('writes valid JSON with the required top-level fields, and findings are identical across runs', () => {
    const a = cli([...fx('links'), '--format', 'json', '--base-url', 'https://example.com/page']);
    const b = cli([...fx('links'), '--format', 'json', '--base-url', 'https://example.com/page']);
    assert.equal(a.code, 1);
    const ra = JSON.parse(a.out) as Report;
    const rb = JSON.parse(b.out) as Report;
    assert.equal(ra.schemaVersion, 1);
    assert.match(ra.toolVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(ra.mode, 'offline');
    assert.equal(ra.sources.html.kind, 'file');
    assert.ok(ra.extraction);
    assert.equal(ra.summary.result, 'fail');
    assert.equal(ra.summary.exitCode, 1);
    assert.ok(ra.summary.coverage);
    assert.ok(Array.isArray(ra.findings) && ra.findings.length > 0);
    for (const f of ra.findings) {
      assert.ok(f.code && f.severity && f.direction && f.message);
      assert.ok(f.html?.line !== undefined || f.markdown?.line !== undefined, 'every finding is locatable');
    }
    assert.deepEqual(ra.findings, rb.findings);
    assert.notEqual(ra.generatedAt, undefined);
  });
  it('--output writes the file and reports on stderr; a write failure is exit 2 without a success line', () => {
    const out = path.join(tmp, 'report.json');
    const r = cli([...fx('same'), '--format', 'json', '--output', out, '--base-url', 'https://example.com/page']);
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.match(r.err, /Report written to .*report\.json \(PASS, exit 0\)/);
    assert.equal((JSON.parse(fs.readFileSync(out, 'utf8')) as Report).summary.result, 'pass');
    assert.equal(cli([...fx('same'), '--strict', '--base-url', 'https://example.com/page']).code, 0, 'an info finding does not fail strict mode');
    const bad = cli([...fx('same'), '--output', path.join(tmp, 'no-such-dir', 'r.txt')]);
    assert.equal(bad.code, 2);
    assert.doesNotMatch(bad.err, /Report written/);
    assert.match(bad.err, /Cannot write report/);
  });
});

describe('URL mode through main() with a loopback harness', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.close();
  });
  const runMain = async (args: string[], injected = true) => {
    let out = '';
    let err = '';
    const code = await main(args, { stdout: (s) => (out += s), stderr: (s) => (err += s) }, injected ? { fetch: (url, o) => fetchUrl(url, { ...o, resolver: h.options('').resolver, testAllowHosts: [h.host] }) } : {});
    return { code, out, err, json: () => JSON.parse(out) as Report };
  };

  it('PASS when the site negotiates Markdown', async () => {
    const r = await runMain(['--url', h.url('/ok'), '--format', 'json']);
    assert.equal(r.code, 0, r.err);
    const j = r.json();
    assert.equal(j.mode, 'url');
    assert.equal(j.sources.markdown.accept, 'text/markdown');
    assert.equal(j.sources.markdown.contentType, 'text/markdown; charset=utf-8');
    assert.equal(j.sources.html.status, 200);
    assert.deepEqual(j.findings, []);
  });
  it('FAIL with number and link findings when the Markdown differs', async () => {
    const r = await runMain(['--url', h.url('/changed')]);
    assert.equal(r.code, 1);
    assert.match(r.out, /NUMBER_CHANGED/);
    assert.match(r.out, /LINK_TARGET_CHANGED/);
    assert.match(r.out, new RegExp(`before: http://${h.host}:${h.port}/pricing`));
  });
  it('--markdown-url fetches the explicit address', async () => {
    const r = await runMain(['--url', h.url('/html-only'), '--markdown-url', h.url('/explicit.md')]);
    assert.equal(r.code, 0, r.out);
  });
  it('Markdown request answered with HTML is a delivery failure, exit 1, no comparison', async () => {
    const r = await runMain(['--url', h.url('/html-only'), '--format', 'json']);
    assert.equal(r.code, 1);
    const j = r.json();
    assert.deepEqual(j.findings.map((f) => f.code), ['DELIVERY_MARKDOWN_IS_HTML']);
    assert.equal(j.extraction, null);
    assert.equal(j.summary.coverage, null);
  });
  it('unexpected content type is a delivery failure; text/plain is a warning', async () => {
    const j = (await runMain(['--url', h.url('/json'), '--format', 'json'])).json();
    assert.deepEqual(j.findings.map((f) => f.code), ['DELIVERY_UNEXPECTED_CONTENT_TYPE']);
    const p = await runMain(['--url', h.url('/plain'), '--format', 'json']);
    assert.equal(p.code, 0);
    assert.deepEqual(p.json().findings.map((f) => f.code), ['DELIVERY_CONTENT_TYPE_PLAIN']);
    assert.equal((await runMain(['--url', h.url('/plain'), '--strict'])).code, 1);
  });
  it('HTTP error on the Markdown request is exit 1, on the HTML request exit 2', async () => {
    const m = await runMain(['--url', h.url('/md-500'), '--format', 'json']);
    assert.equal(m.code, 1);
    assert.deepEqual(m.json().findings.map((f) => f.code), ['DELIVERY_HTTP_ERROR']);
    const n = await runMain(['--url', h.url('/404')]);
    assert.equal(n.code, 2);
    assert.match(n.err, /HTTP 404/);
  });
  it('timeout, oversize and redirect loop are exit 2 with an error report', async () => {
    const t = await runMain(['--url', h.url('/slow'), '--timeout-ms', '300', '--format', 'json']);
    assert.equal(t.code, 2);
    assert.match(t.err, /timeout/);
    assert.equal(t.json().summary.result, 'error');
    const b = await runMain(['--url', h.url('/html-only'), '--markdown-url', h.url('/big'), '--max-bytes', '10000']);
    assert.equal(b.code, 2);
    assert.match(b.err, /too_large/);
    const l = await runMain(['--url', h.url('/loop')]);
    assert.equal(l.code, 2);
    assert.match(l.err, /redirect_loop/);
  });
  it('blocked addresses are exit 2 and the production path blocks the harness itself', async () => {
    const d = await runMain(['--url', 'http://127.0.0.1:1/']);
    assert.equal(d.code, 2);
    assert.match(d.err, /blocked/);
    const r = await runMain(['--url', h.url('/to-private')]);
    assert.equal(r.code, 2);
    assert.match(r.err, /10\.0\.0\.1/);
    // Without the injected resolver the name parity.test has no DNS and the real path never reaches the server.
    const p = await runMain(['--url', h.url('/ok')], false);
    assert.equal(p.code, 2);
    assert.match(p.err, /Fetch failed \((blocked|network)\)/);
  });
  it('masks query values and drops fragments in report URLs', async () => {
    const r = await runMain(['--url', h.url('/ok?token=secret#frag'), '--format', 'json']);
    assert.equal(r.code, 0);
    assert.equal(r.json().sources.html.url, h.url('/ok?token=***'));
    assert.doesNotMatch(r.out, /secret/);
  });
});
