// Promises of README.md and SECURITY.md that no other test reads (round 24, P8). Each test takes the number, the
// name or the sentence from the document and compares it with what the code does, so a document that drifts from the
// behaviour fails here instead of staying wrong until a reader finds it. A test that only repeats a constant would
// pass with a wrong document; these read the document text.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CliError, parseCliArgs } from '../src/cli.js';
import * as core from '../src/core.js';
import { FetchError, fetchUrl } from '../src/fetch.js';
import { run, RunError, type SourceInput } from '../src/run.js';
import { CLI, ROOT } from './helpers.js';
import { MD_PAGE, startHarness, type Harness } from './harness.js';

const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const SECURITY = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');

/** 15000 -> "15 000": the way the documents write a number with a thousands separator (a plain space). */
const spaced = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const file = (body: string): SourceInput => ({ body, base: 'https://example.com/p', meta: { kind: 'file', file: 'f', bytes: Buffer.byteLength(body) } });
const codes = (html: string, markdown: string): string[] =>
  run(file(`<main>${html}</main>`), file(markdown), { mode: 'offline', strict: false }).findings.map((f) => `${f.code}:${f.severity}`);

describe('README example output', () => {
  it('is what the README command prints for the bundled fixture pair, apart from the limitations list', () => {
    const line = README.split('\n').find((l) => l.startsWith('node dist/src/cli.js '));
    assert.ok(line, 'the Development section names the example command');
    const r = spawnSync(process.execPath, [CLI, ...line.slice('node dist/src/cli.js '.length).split(' ')], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const block = /### Example output[\s\S]*?```text\n([\s\S]*?)\n```/.exec(README);
    assert.ok(block, 'the README has an example output block');
    const printed = r.stdout.split('\nLimitations:')[0]!.trimEnd();
    assert.equal(printed, block[1]!.trimEnd());
  });
});

describe('README option ranges and defaults', () => {
  const base = ['--html-file', 'a.html', '--markdown-file', 'b.md'];
  it('the defaults are the ones the README names', () => {
    const args = parseCliArgs(base);
    assert.match(README, new RegExp(`The default is ${spaced(args.timeoutMs)} ms`));
    assert.match(README, new RegExp(`The default is ${args.maxBytes / (1024 * 1024)} MiB`));
    assert.match(SECURITY, new RegExp(`The defaults are ${args.timeoutMs / 1000} seconds and ${args.maxBytes / (1024 * 1024)} MiB`));
  });
  it('the largest accepted values are the README ones and the next value up is refused', () => {
    assert.match(README, /no greater than 2147483647\./);
    assert.match(README, /no greater than 9007199254740991\./);
    assert.equal(parseCliArgs([...base, '--timeout-ms', '2147483647']).timeoutMs, 2147483647);
    assert.throws(() => parseCliArgs([...base, '--timeout-ms', '2147483648']), CliError);
    assert.equal(parseCliArgs([...base, '--max-bytes', '9007199254740991']).maxBytes, 9007199254740991);
    assert.throws(() => parseCliArgs([...base, '--max-bytes', '9007199254740992']), CliError);
  });
  it('a value that is not a plain run of digits is refused', () => {
    for (const bad of ['1e3', '0x10', '5.5', '-5', '+5', ' 5', '0']) {
      assert.throws(() => parseCliArgs([...base, '--timeout-ms', bad]), CliError, bad);
      assert.throws(() => parseCliArgs([...base, '--max-bytes', bad]), CliError, bad);
    }
  });
  it('the limits the documents name are the ones in the code', () => {
    assert.match(README, new RegExp(`Up to ${spaced(core.MAX_ALIGNMENT_PAIRS)} block pairs`));
    assert.match(README, new RegExp(`more than ${spaced(core.MAX_SIMILARITY_CANDIDATES)} similar block pairs`));
    assert.match(README, new RegExp(`more than ${core.MAX_NESTING_DEPTH} levels deep`));
    assert.match(SECURITY, new RegExp(`at most ${spaced(core.MAX_ALIGNMENT_PAIRS)}`));
    assert.equal(core.DEFAULT_LIMITS.maxAlignmentPairs, core.MAX_ALIGNMENT_PAIRS);
    assert.equal(core.DEFAULT_LIMITS.maxSimilarityCandidates, core.MAX_SIMILARITY_CANDIDATES);
    assert.equal(core.DEFAULT_LIMITS.maxSimilarityWork, Infinity);
  });
});

describe('README promises about fetching', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.close();
  });

  it('sends the Accept-Encoding header the README names', async () => {
    const sent = await fetchUrl(h.url('/accept-encoding'), h.options('text/markdown'));
    assert.equal(sent.body, 'gzip, deflate, br');
    assert.ok(README.includes('`Accept-Encoding: gzip, deflate, br`'));
  });
  it('decodes identity, gzip and x-gzip, and refuses zstd', async () => {
    for (const p of ['/ok', '/identity', '/gzip', '/x-gzip']) {
      assert.equal((await fetchUrl(h.url(p), h.options('text/markdown'))).body, MD_PAGE, p);
    }
    for (const name of ['identity', 'gzip', 'x-gzip', 'deflate', 'br']) assert.ok(README.includes(`\`${name}\``), name);
    await assert.rejects(
      fetchUrl(h.url('/zstd'), h.options('text/markdown')),
      (e: unknown) => e instanceof FetchError && e.kind === 'protocol' && /Unsupported Content-Encoding: zstd/.test(e.message),
    );
    assert.ok(README.includes('`zstd`'));
  });
  it('does not use HTTP_PROXY or HTTPS_PROXY: a dead proxy address does not stop the fetch', async () => {
    const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
    const saved = names.map((n) => process.env[n]);
    try {
      for (const n of names) process.env[n] = 'http://127.0.0.1:9';
      assert.equal((await fetchUrl(h.url('/ok'), h.options('text/markdown'))).body, MD_PAGE);
    } finally {
      names.forEach((n, i) => {
        if (saved[i] === undefined) delete process.env[n];
        else process.env[n] = saved[i];
      });
    }
    assert.ok(README.includes('does not use `HTTP_PROXY` or `HTTPS_PROXY`'));
  });
  it('follows five redirects and refuses the sixth', async () => {
    const five = await fetchUrl(h.url('/chain?left=5'), h.options('text/markdown'));
    assert.equal(five.redirects, 5);
    assert.equal(five.body, MD_PAGE);
    await assert.rejects(fetchUrl(h.url('/chain?left=6'), h.options('text/markdown')), (e: unknown) => e instanceof FetchError && e.kind === 'too_many_redirects');
    assert.ok(README.includes('follows at most 5 redirects'));
  });
});

describe('README promises about the comparison', () => {
  const table = (attr: string) => `<table><tr><th${attr}>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>`;
  const mdTable = '| A | B |\n| - | - |\n| 1 | 2 |\n';
  it('skips the cell comparison for a span above 1, a rowspan of 0 and a value that does not begin with a number, and reads leading digits', () => {
    const skipped = 'EXTRACTION_TABLE_SPAN_NOT_COMPARED:info';
    for (const attr of [' colspan="2"', ' rowspan="2"', ' colspan="2abc"', ' rowspan="2abc"', ' colspan=""', ' rowspan=""', ' colspan="abc"', ' rowspan="0"']) {
      assert.deepEqual(codes(table(attr), mdTable), [skipped], attr);
    }
    for (const attr of ['', ' colspan="0"', ' colspan="0abc"', ' rowspan="1"', ' colspan="1"', ' colspan="1abc"', ' rowspan="1abc"']) {
      assert.deepEqual(codes(table(attr), mdTable), [], attr);
    }
    assert.ok(README.includes('`2abc` counts as 2'));
    assert.ok(README.includes('A colspan of 0 and a rowspan or colspan of 1 do not trigger it'));
  });
  it('treats an ASCII arrow against an arrow character and a dropped trademark sign as errors, and the same arrow on both sides as equal', () => {
    assert.deepEqual(codes('<p>Go -&gt; next</p>', 'Go → next\n'), ['TEXT_CHANGED:error']);
    assert.deepEqual(codes('<p>Acme™ tool</p>', 'Acme tool\n'), ['TEXT_CHANGED:error']);
    assert.deepEqual(codes('<p>Go -&gt; next</p>', 'Go -> next\n'), []);
    assert.ok(README.includes('an ASCII arrow made of a hyphen and a greater-than sign against an arrow character, or a dropped trademark sign'));
  });
});

describe('README report format', () => {
  it('lists every top-level field of a report and every always-present summary field', () => {
    const report = run(file('<main><p>Same.</p></main>'), file('Same.\n'), { mode: 'offline', strict: false });
    for (const key of Object.keys(report)) assert.ok(README.includes(`| \`${key}\` |`), `the report table lacks ${key}`);
    const summaryRow = README.split('\n').find((l) => l.startsWith('| `summary` |'))!;
    for (const key of Object.keys(report.summary)) assert.ok(summaryRow.includes(`\`${key}\``), `the summary row lacks ${key}`);
    assert.equal(report.schemaVersion, 1);
    assert.ok(README.includes('| `schemaVersion` | The number `1`. |'));
    for (const key of ['error', 'errorValue']) assert.ok(summaryRow.includes(`\`${key}\``), key);
  });
});

describe('CI matrix named in the documents', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const list = (key: string): string[] => {
    const m = new RegExp(`${key}: \\[([^\\]]+)\\]`).exec(ci);
    assert.ok(m, `ci.yml has no ${key} matrix`);
    return m[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  };
  const nodes = list('node');
  const systems = list('os').map((s) => s.replace(/-latest$/, '')).map((s) => s[0]!.toUpperCase() + s.slice(1));
  const nodePhrase = `Node.js ${nodes.slice(0, -1).join(', ')} and ${nodes[nodes.length - 1]}`;
  const lineWith = (text: string, needle: string): string => {
    const line = text.split('\n').find((l) => l.includes(needle));
    assert.ok(line, `no line with ${needle}`);
    return line;
  };
  it('README, SECURITY and the release notes sentence name the Node.js versions and systems of ci.yml', () => {
    const lines = [
      [lineWith(README, 'GitHub Actions tests'), true],
      [lineWith(release, 'after CI passed on'), true],
      [lineWith(SECURITY, 'runs type checks and tests on'), false],
    ] as const;
    for (const [line, withNodes] of lines) {
      if (withNodes) assert.ok(line.includes(nodePhrase), `${line} lacks ${nodePhrase}`);
      for (const s of systems) assert.ok(line.includes(s), `${line} lacks ${s}`);
      for (const other of ['Windows', 'Ubuntu', 'macOS', 'Linux'].filter((s) => !systems.includes(s))) assert.ok(!line.includes(other), `${line} names ${other}, which ci.yml does not run`);
    }
  });
});

describe('library claims', () => {
  it('the README names only exports the library entry has, and does not name align or compare as functions to call', () => {
    const imported = /import \{ ([^}]+) \} from 'markdown-parity-check';/.exec(README);
    assert.ok(imported, 'the README has a runtime import example');
    for (const name of imported[1]!.split(',').map((s) => s.trim())) assert.ok(name in core, `${name} is not exported`);
    for (const doc of [README, SECURITY]) {
      assert.doesNotMatch(doc, /`align`|`compare`/, 'align and compare are not exported from the package entry');
    }
    for (const name of ['assertPublicHost', 'isPublicAddress', 'errorReport', 'renderJson']) assert.ok(name in core, name);
  });
  it('a similarity work limit stops the worst case the documents describe, as a RunError and not as the internal error type', () => {
    // 100 HTML blocks of 870 distinct words against 40 000 Markdown blocks of one word: 4 000 000 block pairs, which is
    // exactly the pair limit. The unbounded run is the 26 to 30 seconds the documents report as a hand measurement and is
    // not run here; this test runs the bounded one and asserts no time, because a fixed limit would depend on the machine.
    const word = (i: number) => `w${i.toString(36).padStart(4, 'x')}`;
    const html = Array.from({ length: 100 }, (_, b) => `<p>${Array.from({ length: 870 }, (_, i) => word(b * 870 + i)).join(' ')}</p>`).join('');
    const markdown = `${Array.from({ length: 40000 }, (_, i) => word(i)).join('\n\n')}\n`;
    assert.equal(100 * 40000, core.MAX_ALIGNMENT_PAIRS);
    assert.doesNotThrow(() => core.checkAlignmentLimit(100, 40000));
    assert.throws(
      () => run(file(`<main>${html}</main>`), file(markdown), { mode: 'offline', strict: false, limits: { maxSimilarityWork: 2_000_000 } }),
      (e: unknown) =>
        e instanceof RunError &&
        !(e instanceof core.AlignmentLimitError) &&
        /Comparison limit exceeded: the similarity search among 100 unmatched HTML blocks and 40000 unmatched Markdown blocks needs more than 2000000 token comparisons/.test(e.message),
    );
    assert.match(README, /a value of 2 000 000 made the pairing step stop/);
    assert.match(SECURITY, /a limit of 2 000 000 made the pairing step stop/);
  });
});
