// Regression tests for release 0.2.43: the leaks of the second outside masking run against 0.2.42 (C1c, 2026-11-22).
// Report text that held a moved-user-information address (PF1, and the backslash address of K2-F5), the error of a
// --selector (PF5), a scheme-less target whose password holds a number sign, a question mark, a space or a backslash
// (PL1, PF3), a rejected option value (PF2, PF4), and the bytes of a Location header (PU1). Each test that names a
// secret fails on 0.2.42. A test whose name ends in "(control)" pins a shape that must be shown as before. The secret
// is a made-up canary value, no real credential.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { main } from '../src/cli.js';
import { fetchUrl, FetchError, type FetchOptions, type Resolver } from '../src/fetch.js';
import { movedUserinfoMask, redactText } from '../src/normalize.js';
import { renderJson, renderText } from '../src/report.js';
import { run, type SourceInput } from '../src/run.js';

const SECRET = 'CANARYPWD7f3a';
const BS = String.fromCharCode(92);
const BASE = 'https://example.com/dir/page';

const source = (file: string, body: string, base: string | null): SourceInput => ({
  meta: { kind: 'file', file, bytes: body.length, baseUrl: base },
  body,
  base,
});
const both = (r: ReturnType<typeof run>) => renderJson(r) + renderText(r);

async function cli(argv: string[], deps?: Parameters<typeof main>[2]): Promise<string> {
  let out = '';
  const io = { stdout: (s: string) => { out += s; }, stderr: (s: string) => { out += s; } };
  await main(argv, io, deps);
  return out;
}

describe('K2-F3: the role attribute is a list of tokens', () => {
  const exit = (role: string) => {
    const r = run(source('a.html', `<main><p>Body text here.</p><div role="${role}"><p>Extra words in the element.</p></div></main>`, BASE), source('a.md', 'Body text here.\n', BASE), { mode: 'offline', strict: false });
    return r.summary.exitCode;
  };
  for (const role of ['navigation foo', ' navigation ', 'foo navigation', 'Navigation', 'navigation', 'search  banner', 'foo\tcomplementary\nbar']) {
    it(`leaves the element out: ${JSON.stringify(role)}`, () => assert.equal(exit(role), 0));
  }
  for (const role of ['foo', 'menuitem', 'presentation navigation', '', 'navigationx']) {
    it(`compares the element (control): ${JSON.stringify(role)}`, () => assert.equal(exit(role), 1));
  }
});

describe('PF1 and K2-F5: report text holds the same masking as a link target', () => {
  const forms = [
    `DOMAIN${BS}erik:${SECRET}@host.example/p`,
    `https://erik:${SECRET}?x@host.example/p`,
    `https://CORP${BS}erik:${SECRET}@host.example/x`,
    `:${SECRET}@host.example/x`,
    `//erik:${SECRET} x@host.example/p`,
    `gopher:user:${SECRET}@host.example/y`,
    `https://erik:${SECRET}#x@host.example/p`,
  ];
  for (const f of forms) {
    it(`is masked in an HTML paragraph and in a Markdown paragraph: ${JSON.stringify(f)}`, () => {
      const html = f.replace(/&/g, '&amp;');
      const r = run(source('a.html', `<main><p>See ${html} now</p></main>`, BASE), source('a.md', `See ${f} later\n`, BASE), { mode: 'offline', strict: false });
      assert.ok(r.findings.length > 0);
      assert.ok(!both(r).includes(SECRET), both(r));
    });
  }
  it('masks a Markdown autolink and its text', () => {
    const f = `https://CORP${BS}erik:${SECRET}@host.example/x`;
    const r = run(source('a.html', '<main><p>See it</p></main>', BASE), source('a.md', `See <${f}> now\n`, BASE), { mode: 'offline', strict: false });
    assert.ok(!both(r).includes(SECRET), both(r));
  });
  it('masks redactText itself and shows the same shape as a link target', () => {
    assert.ok(!redactText(`x https://CORP${BS}erik:${SECRET}@host.example/x y`).includes(SECRET));
    assert.ok(!redactText(`(${`DOMAIN${BS}erik:${SECRET}@host.example/p`}).`).includes(SECRET));
    assert.ok(redactText(`x https://CORP${BS}erik:${SECRET}@host.example/x y`).includes('https://***'));
  });
  it('leaves an e-mail address, a path with an at sign, a Windows path and a labelled address as before (control)', () => {
    assert.equal(redactText('Write to jane@example.com now'), 'Write to jane@example.com now');
    assert.equal(redactText('See https://medium.com/@user/post here'), 'See https://medium.com/@user/post here');
    assert.equal(redactText(`Open C:${BS}dir${BS}file@2x.png now`), `Open C:${BS}dir${BS}file@2x.png now`);
    assert.equal(redactText('Contact:jane@example.com'), 'Contact:jane@example.com');
    assert.equal(redactText(`See user:${SECRET}@host.example/p?x=1 now`), 'See user:***@host.example/p?x=*** now');
  });
});

describe('PF5: a rejected --selector', () => {
  const selectors = [`erik:${SECRET}]x#y@example.com`, `https://erik:${SECRET}?x@host.example/p`, `a[href="https://erik:${SECRET}?x@h"`, `:${SECRET}@h`];
  const withFiles = async (fn: (html: string, md: string) => Promise<void>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-1123s-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.html'), '<main><p>x</p></main>');
      fs.writeFileSync(path.join(dir, 'a.md'), 'x\n');
      await fn(path.join(dir, 'a.html'), path.join(dir, 'a.md'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  for (const s of selectors) {
    it(`does not repeat the secret in the text or the JSON report: ${JSON.stringify(s)}`, async () => {
      await withFiles(async (html, md) => {
        for (const format of ['text', 'json']) {
          const out = await cli(['--html-file', html, '--markdown-file', md, '--selector', s, '--format', format]);
          assert.match(out, /Invalid selector/, format);
          assert.ok(!out.toLowerCase().includes(SECRET.toLowerCase()), `${format}: ${out}`);
        }
      });
    });
  }
  it('still names an ordinary invalid selector (control)', async () => {
    await withFiles(async (html, md) => {
      const out = await cli(['--html-file', html, '--markdown-file', md, '--selector', 'div[']);
      assert.match(out, /Invalid selector: /);
      assert.doesNotMatch(out, /not repeated/);
    });
  });
});

describe('PL1: a scheme-less link target whose password holds a number sign, a question mark, a space or a backslash', () => {
  const targets = [
    `erik:${SECRET}#x@host.example/p`,
    `erik:ab?${SECRET}@host.example/p`,
    `erik:${SECRET} x@host.example/p`,
    `erik:${SECRET}${BS}x@host.example/p`,
  ];
  for (const t of targets) {
    it(`is masked in the link finding: ${JSON.stringify(t)}`, () => {
      assert.notEqual(movedUserinfoMask(t), null);
      const r = run(source('a.html', `<main><p>x <a href="${t}">L</a></p></main>`, BASE), source('a.md', 'x L\n', BASE), { mode: 'offline', strict: false });
      assert.ok(r.findings.some((f) => f.code === 'LINK_MISSING'));
      assert.ok(!both(r).includes(SECRET), both(r));
      const m = run(source('a.html', '<main><p>x L</p></main>', BASE), source('a.md', `x [L](<${t}>)\n`, BASE), { mode: 'offline', strict: false });
      assert.ok(!both(m).includes(SECRET), both(m));
    });
  }
  it('shows the labelled form, a Windows path and an address scheme as before (control)', () => {
    assert.equal(movedUserinfoMask(`user:${SECRET}@host.example/p`), null);
    assert.equal(movedUserinfoMask(`C:${BS}dir${BS}file@2x.png`), null);
    assert.equal(movedUserinfoMask('mailto:jane@example.com?subject=a#b'), null);
    assert.equal(movedUserinfoMask('docs/a@b'), null);
  });
});

describe('PF2 and PF4: a rejected option value', () => {
  it('does not echo a backslash authority in --base-url, --timeout-ms or --html-file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-1123-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.html'), '<main><p>x</p></main>');
      fs.writeFileSync(path.join(dir, 'a.md'), 'x\n');
      const html = path.join(dir, 'a.html');
      const md = path.join(dir, 'a.md');
      for (const scheme of ['ftp', 'ws', 'file', 'https']) {
        const v = `${scheme}://corp.example${BS}erik:${SECRET}@example.com/x`;
        for (const format of ['text', 'json']) {
          assert.ok(!(await cli(['--html-file', html, '--markdown-file', md, '--base-url', v, '--format', format])).includes(SECRET), `${scheme} base ${format}`);
          assert.ok(!(await cli(['--html-file', html, '--markdown-file', md, '--timeout-ms', v, '--format', format])).includes(SECRET), `${scheme} timeout ${format}`);
          assert.ok(!(await cli(['--html-file', v, '--markdown-file', md, '--format', format])).includes(SECRET), `${scheme} file ${format}`);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('still names an ordinary bad value (control)', async () => {
    const out = await cli(['--html-file', 'a.html', '--markdown-file', 'a.md', '--timeout-ms', 'abc']);
    assert.match(out, /--timeout-ms must be a positive integer \(got "abc"\)/);
  });
});

describe('URL mode: PF3 and PU1', () => {
  const host = 'parity.test';
  let server: http.Server;
  let port = 0;
  const resolver: Resolver = async (h) => {
    if (h === host) return [{ address: '127.0.0.1', family: 4 }];
    throw new Error(`ENOTFOUND ${h}`);
  };
  const options = (accept: string): FetchOptions => ({ accept, timeoutMs: 3000, maxBytes: 1 << 20, resolver, testAllowHosts: [host] });
  const url = (p: string) => `http://${host}:${port}${p}`;
  // The bytes of a Location as the server writes them: UTF-8, carried by a string of latin1 code units.
  const bytes = (s: string) => Buffer.from(s, 'utf8').toString('latin1');
  before(async () => {
    server = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      const go = (location: string) => { res.writeHead(302, { location }); res.end(); };
      if (p === '/hash') return go(`erik:${SECRET}#x@example.com/p`);
      if (p === '/query') return go(`erik:ab?${SECRET}@example.com/p`);
      if (p === '/space') return go(`erik:${SECRET} x@example.com/p`);
      if (p === '/bs') return go(`erik:${SECRET}${BS}x@example.com/p`);
      if (p === '/u3000') return go(bytes(`\u3000/${BS}erik:${SECRET}@example.com/p`));
      if (p === '/ufffd') return go(bytes(`\ufffd/${BS}erik:${SECRET}@example.com/p`));
      if (p === '/nbsp') return go(bytes(`\u00a0/${BS}erik:${SECRET}@example.com/p`));
      if (p === '/plain') return go(bytes('/caf\u00e9?k=v'));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<main><p>x</p></main>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

  for (const p of ['/hash', '/query', '/space', '/bs']) {
    it(`masks the fetch error of a refused scheme-less Location ${p}`, async () => {
      await assert.rejects(fetchUrl(url(p), options('text/html')), (e: unknown) => {
        assert.ok(e instanceof FetchError);
        assert.ok(!(e.url + e.message).includes(SECRET), e.url + e.message);
        return true;
      });
      for (const format of ['text', 'json']) {
        const out = await cli(['--url', url(p), '--format', format], { fetch: (u, o) => fetchUrl(u, { ...o, resolver, testAllowHosts: [host] }) });
        assert.ok(!out.includes(SECRET), `${p} ${format}: ${out}`);
      }
    });
  }
  for (const p of ['/u3000', '/ufffd', '/nbsp']) {
    it(`reads the bytes of Location ${p} as UTF-8 and masks the followed address`, async () => {
      const r = await fetchUrl(url(p), options('text/html'));
      assert.equal(r.shownFinalUrl, 'http://***/');
      for (const format of ['text', 'json']) {
        const out = await cli(['--url', url(p), '--markdown-url', url(p), '--format', format], { fetch: (u, o) => fetchUrl(u, { ...o, resolver, testAllowHosts: [host] }) });
        assert.ok(!out.includes(SECRET), `${p} ${format}: ${out}`);
      }
    });
  }
  it('follows a Location with UTF-8 bytes to the path a browser follows (control)', async () => {
    const r = await fetchUrl(url('/plain'), options('text/html'));
    assert.equal(r.shownFinalUrl, undefined);
    assert.equal(r.finalUrl, `http://${host}:${port}/caf%C3%A9?k=v`);
  });
});
