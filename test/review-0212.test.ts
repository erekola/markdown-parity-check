// Regressions for the outside review of 2026-09-26 (0.2.12): URL secrets that still reached a report or stderr
// (F02, F03, F04), a connection left open on an unknown Content-Encoding (F01), per-block number and link work
// that grew with the square of the count (F09), --output through a hard link (F10) and IPv6 blocks that are not
// globally reachable (F14). Every secret value below is synthetic. The masking tests carry the three classes at
// once: secrets that go, benign addresses that stay byte for byte, and benign addresses the URL parser refuses.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { main } from '../src/cli.js';
import { compare } from '../src/compare.js';
import { fetchUrl, FetchError } from '../src/fetch.js';
import type { Block, Extraction, Link } from '../src/model.js';
import { isPublicAddress } from '../src/netguard.js';
import { extractNumbers, hideUrlSecrets, insideHiddenUrlPart, looseNormalize, redactText, visibleNumbers } from '../src/normalize.js';
import { CLI, ROOT } from './helpers.js';

// Underscores on purpose: they make GFM read the part after the colon as an email address.
const USER = 'synthetic_user';
const PASSWORD = 'SYNTHETIC_PASS_NOTREAL';
const TOKEN = '924681357024681357';
const OTHER_TOKEN = '135792468013579246';
const SECRETS = new RegExp(`${USER}|${PASSWORD}|${TOKEN}|${OTHER_TOKEN}|SECRETPATHVALUE`);

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

let tmp: string;
before(() => {
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  tmp = fs.mkdtempSync(path.join(ROOT, '.tmp', 'review-0212-'));
});
after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // A sandbox without delete permission leaves the temp folder behind; that is not a test failure.
  }
});

function pair(name: string, html: string, md: string): string[] {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'page.html'), `<!doctype html><html><body><main>${html}</main></body></html>`);
  fs.writeFileSync(path.join(dir, 'page.md'), md);
  return ['--html-file', path.join(dir, 'page.html'), '--markdown-file', path.join(dir, 'page.md')];
}

describe('F02: a link GFM makes out of a hidden part of a URL', () => {
  it('insideHiddenUrlPart finds user information, query values and fragments, and nothing else', () => {
    const at = (text: string, part: string) => insideHiddenUrlPart(text, text.indexOf(part));
    assert.equal(at(`Open https://${USER}:${PASSWORD}@example.test/page now`, `${PASSWORD}@`), true);
    assert.equal(at(`Open //${USER}:${PASSWORD}@example.test/page now`, `${PASSWORD}@`), true);
    assert.equal(at('See /p?next=https://y.test/deep now', 'https://y'), true);
    assert.equal(at('See https://x.test/?t=(a@b.test) now', 'a@b'), true);
    assert.equal(at('See https://x.test/a#part-a@b.test now', 'a@b'), true);
    // Benign: the link starts its own token, or follows an opening parenthesis outside any URL.
    assert.equal(at('Mail me at a@b.test today.', 'a@b'), false);
    assert.equal(at('Visit (www.y.test) and more.', 'www.'), false);
    assert.equal(at('See https://example.com/@user/post now', 'https://'), false);
    assert.equal(at(`Open https:${USER}:${PASSWORD}@example.test/page now`, `${PASSWORD}@`), true);
    // A token longer than the scan counts as hidden.
    assert.equal(at(`${'a'.repeat(5000)}x@b.test`, 'x@b'), true);
  });

  it('through the real CLI the password is in no field of either format, and the link finding stays', () => {
    const sentence = `Open https://${USER}:${PASSWORD}@example.test/page for the private report details today.`;
    const args = pair('userinfo', `<p>${sentence}</p>`, `${sentence}\n`);
    for (const format of ['text', 'json']) {
      const r = cli([...args, '--format', format]);
      assert.equal(r.code, 1, r.err);
      assert.match(r.out, /LINK_ADDED/);
      assert.doesNotMatch(r.out + r.err, SECRETS);
    }
  });

  it('a URL given as a query value is masked, and a link of its own next to it is still shown', () => {
    const args = pair('query-link', '<p>See /p?next=https://y.test/SECRETPATHVALUE and mail a@b.test.</p>', 'See /p?next=https://y.test/SECRETPATHVALUE and mail a@b.test.\n');
    const r = cli([...args, '--format', 'json']);
    assert.equal(r.code, 1, r.err);
    assert.doesNotMatch(r.out + r.err, SECRETS);
    const report = JSON.parse(r.out) as { findings: Array<{ code: string; message: string }> };
    const added = report.findings.filter((f) => f.code === 'LINK_ADDED').map((f) => f.message);
    assert.equal(added.length, 2);
    assert.ok(added.some((m) => m.includes('"***"')), added.join('\n'));
    assert.ok(added.some((m) => m.includes('a@b.test')), added.join('\n'));
  });
});

describe('a special scheme with user information behind zero or one separator (independent review before 0.2.12)', () => {
  const bs = String.fromCharCode(92);
  it('redactText masks it, and benign text with the same shape keeps its bytes', () => {
    for (const url of [`https:${USER}:${PASSWORD}@example.test/page`, `https:${bs}${USER}:${PASSWORD}@example.test${bs}page`, `https:/${USER}:${PASSWORD}@example.test/page`, `FTP:${USER}:${PASSWORD}@example.test/`]) {
      const out = redactText(`Open ${url} now.`);
      assert.doesNotMatch(out, SECRETS, url);
      assert.match(out, /example\.test/, url);
    }
    for (const text of ['the http:status page and ftp:files', 'see https:example.com/@user/post now', 'mail me@example.com or file:notes']) {
      assert.equal(redactText(text), text);
    }
  });

  it('through the real CLI the GFM email link it makes is masked, in text and in JSON', () => {
    const sentence = `Text https:${USER}:${PASSWORD}@example.test/path2 more.`;
    const args = pair('zero-separator', `<p>${sentence}</p>`, `${sentence}\n`);
    for (const format of ['text', 'json']) {
      const r = cli([...args, '--format', format]);
      assert.equal(r.code, 1, r.err);
      assert.match(r.out, /LINK_ADDED/);
      assert.doesNotMatch(r.out + r.err, SECRETS);
    }
  });
});

describe('F03: a query value that holds parentheses or quotes', () => {
  it('redactText, hideUrlSecrets and visibleNumbers hide the whole value', () => {
    for (const value of [`(${TOKEN})`, `'${TOKEN}'`, `"${TOKEN}"`, `x(${TOKEN}`]) {
      const text = `Open https://example.test/view?token=${value} today`;
      assert.doesNotMatch(redactText(text), SECRETS, text);
      assert.doesNotMatch(visibleNumbers(text).join(' '), SECRETS, text);
      assert.doesNotMatch(hideUrlSecrets(text), SECRETS, text);
    }
  });

  it('benign text keeps its bytes: punctuation around a URL, balanced parentheses, and addresses the parser refuses', () => {
    assert.equal(redactText('(see https://example.com/a) and "https://example.com/b".'), '(see https://example.com/a) and "https://example.com/b".');
    assert.equal(redactText('at https://example.com/wiki/Foo_(bar), then'), 'at https://example.com/wiki/Foo_(bar), then');
    assert.equal(redactText('(see //example.com/@user/(post)) and me@example.com'), '(see //example.com/@user/(post)) and me@example.com');
    assert.equal(redactText(`at https://example.com/?q=${TOKEN}), then`), 'at https://example.com/?q=***), then');
    // Known cost, kept on purpose: text glued to a query value without a space is part of the value to the parser.
    assert.equal(redactText("https://example.com/a?x=1's page."), 'https://example.com/a?x=*** page.');
    assert.deepEqual(visibleNumbers('Pay 10 € (see https://example.com/v2/a).'), extractNumbers('Pay 10 € (see https://example.com/v2/a).'));
  });

  it('through the real CLI neither value is in any field of either format', () => {
    const args = pair('paren-query', `<p>Open https://example.test/view?token=(${TOKEN}) for the private report.</p>`, `Open https://example.test/view?token=(${OTHER_TOKEN}) for the private report.\n`);
    for (const format of ['text', 'json']) {
      const r = cli([...args, '--format', format]);
      assert.equal(r.code, 1, r.err);
      assert.match(r.out, /NUMBER_CHANGED/);
      assert.doesNotMatch(r.out + r.err, SECRETS);
    }
  });
});

describe('F04: stderr goes through the same masking as the report', () => {
  const run = async (argv: string[], deps = {}) => {
    let out = '';
    let err = '';
    const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s) }, deps);
    return { code, out, err };
  };

  it('a refused --base-url and an unexpected positional URL are not repeated in the clear', async () => {
    const url = `ftp://${USER}:${PASSWORD}@example.test/?token=${TOKEN}`;
    const args = pair('stderr', '<p>Hello world.</p>', 'Hello world.\n');
    const a = await run([...args, '--base-url', url]);
    assert.equal(a.code, 2);
    assert.match(a.err, /--base-url must be/);
    assert.doesNotMatch(a.out + a.err, SECRETS);
    const b = await run([...args, `https://${USER}:${PASSWORD}@example.test/?token=${TOKEN}`]);
    assert.equal(b.code, 2);
    assert.match(b.err, /Unexpected argument/);
    assert.doesNotMatch(b.out + b.err, SECRETS);
  });

  it('a fetch error that repeats a server header reaches neither stdout nor stderr in the clear', async () => {
    const fetch = async () => {
      throw new FetchError('protocol', 'https://example.test/', `Unsupported Content-Encoding: https://example.test/?t=${TOKEN}`);
    };
    for (const format of ['text', 'json']) {
      const r = await run(['--url', 'https://example.test/', '--format', format], { fetch });
      assert.equal(r.code, 2);
      assert.match(r.err, /Unsupported Content-Encoding/);
      assert.doesNotMatch(r.out + r.err, SECRETS);
    }
  });
});

describe('F01: an unknown Content-Encoding closes the connection', () => {
  it('the server sees the socket close soon after the fetch fails, and the message is masked', async () => {
    const sockets = new Set<Socket>();
    let closedAt = 0;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': `x-unknown?t=${TOKEN}` });
      const timer = setInterval(() => res.write(Buffer.alloc(512, 0x61)), 20);
      res.socket?.on('close', () => {
        clearInterval(timer);
        closedAt = Date.now();
      });
    });
    server.on('connection', (s) => sockets.add(s));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      let error: unknown;
      try {
        await fetchUrl(`http://127.0.0.1:${port}/`, { accept: 'text/html', timeoutMs: 5000, maxBytes: 100, testAllowHosts: ['127.0.0.1'], resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
      } catch (e) {
        error = e;
      }
      const failedAt = Date.now();
      assert.ok(error instanceof FetchError);
      assert.equal(error.kind, 'protocol');
      assert.doesNotMatch(error.message, SECRETS);
      for (let i = 0; i < 50 && closedAt === 0; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(closedAt > 0, 'the server socket is still open 1 s after the fetch failed');
      assert.ok(closedAt - failedAt < 1000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('F09: one block with many numbers or links', () => {
  const extraction = (text: string, links: Link[] = []): Extraction => ({
    blocks: [{ type: 'paragraph', text, loose: looseNormalize(text), links, numbers: extractNumbers(text), location: { line: 1, blockIndex: 0 } } as Block],
    strategy: 'synthetic',
    confidence: 'high',
    notes: [],
    issues: [],
  });

  it('20 000 numbers in reverse order compare in well under a second', () => {
    const nums = Array.from({ length: 20000 }, (_, i) => String(i + 1));
    const t0 = performance.now();
    const r = compare(extraction(nums.join(' ')), extraction([...nums].reverse().join(' ')));
    const ms = performance.now() - t0;
    assert.equal(r.findings.filter((f) => f.code === 'NUMBER_CHANGED').length, 1);
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
  });

  it('20 000 same-text links compare in well under a second, whether the targets match in reverse order or not at all', () => {
    const make = (dir: string) => Array.from({ length: 20000 }, (_, i) => ({ text: 'download', rawHref: `/${dir}/${i}`, resolved: `https://example.test/${dir}/${i}` }));
    const links = make('f');
    const text = links.map(() => 'download').join(' ');
    for (const [other, changed] of [[[...links].reverse(), 0], [make('g').reverse(), 20000]] as const) {
      const t0 = performance.now();
      const r = compare(extraction(text, links), extraction(text, [...other]));
      const ms = performance.now() - t0;
      assert.equal(r.findings.filter((f) => f.code === 'LINK_TARGET_CHANGED').length, changed);
      assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
    }
  });
});

describe('F10: --output never overwrites an input', () => {
  it('refuses a hard link to an input and leaves the input as it was', (t) => {
    const args = pair('hardlink', '<p>Hello world.</p>', 'Hello world.\n');
    const htmlFile = args[1]!;
    const link = path.join(path.dirname(htmlFile), 'report.json');
    try {
      fs.linkSync(htmlFile, link);
    } catch {
      t.skip('this file system does not support hard links');
      return;
    }
    const before = fs.readFileSync(htmlFile, 'utf8');
    const r = cli([...args, '--output', link, '--format', 'json']);
    assert.equal(r.code, 2);
    assert.match(r.err, /must not point at an input file/);
    assert.equal(fs.readFileSync(htmlFile, 'utf8'), before);
  });

  it('writes a new report file and leaves no temporary file behind', () => {
    const args = pair('output', '<p>Hello world.</p>', 'Hello world.\n');
    const dir = path.dirname(args[1]!);
    const out = path.join(dir, 'report.json');
    fs.writeFileSync(out, 'old');
    const r = cli([...args, '--output', out, '--format', 'json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).summary.result, 'pass');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  });
});

describe('F14: IPv6 blocks the IANA registry marks not globally reachable', () => {
  it('refuses them and keeps the registered exceptions public', () => {
    for (const ip of ['2001:2::1', '2001:2:0:ffff::1', '3fff::1', '3fff:fff:ffff::1', '5f00::1', '5f00:ffff::1', '100:0:0:1::1', '2001:10::1', '2001:1::4', '2001:5::1', '2001:1ff::1']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['2001:1::1', '2001:1::2', '2001:1::3', '2001:3::1', '2001:4:112::1', '2001:20::1', '2001:3f::1', '2001:200::1', '3fff:1000::1', '5f01::1', '100:0:0:2::1']) {
      assert.equal(isPublicAddress(ip), true, ip);
    }
  });
});
