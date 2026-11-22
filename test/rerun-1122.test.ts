// Regression tests for release 0.2.42: the leaks an independent rerun against 0.2.41 found on 2026-11-22. Scheme-less
// link targets whose user part holds a backslash, nothing or an "@" (n3 to n5), a --base-url or a document base that
// hides user information (n6), and the same class in the URL mode, where a followed redirect whose Location reads as
// user information put the secret into the final address and into every link resolved against it. The tests that
// name a secret fail on 0.2.41. A test whose name ends in "(control)" pins a target that must be shown as before. The
// secret is a made-up canary value, no real credential.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { main } from '../src/cli.js';
import { fetchUrl, FetchError, type FetchOptions, type Resolver } from '../src/fetch.js';
import { movedUserinfoMask } from '../src/normalize.js';
import { renderJson, renderText } from '../src/report.js';
import { run, type SourceInput } from '../src/run.js';

const SECRET = 'CANARYPWD7f3a';
const BS = String.fromCharCode(92);
const BASE = 'https://example.com/dir/page';

const source = (file: string, body: string, base: string | null, meta?: string | null): SourceInput => ({
  meta: { kind: 'file', file, bytes: body.length, baseUrl: meta === undefined ? base : meta },
  body,
  base,
});
const both = (r: ReturnType<typeof run>) => renderJson(r) + renderText(r);

describe('n3 to n5: a scheme-less target with a colon and no slash before its last @', () => {
  const masked = [
    `CORP${BS}erik:${SECRET}@example.com/p`,
    `:${SECRET}@example.com/p`,
    `:${SECRET}@e.com?k=v`,
    `erik@:${SECRET}@example.com/p`,
    `${BS}user:${SECRET}@example.com/p`,
  ];
  for (const t of masked) {
    it(`is shown as *** in every report: ${JSON.stringify(t)}`, () => {
      assert.equal(movedUserinfoMask(t), '***');
      const r = run(source('a.html', `<main><p>x <a href="${t}">L</a></p></main>`, BASE), source('a.md', 'x L\n', BASE), { mode: 'offline', strict: false });
      const f = r.findings.find((x) => x.code === 'LINK_MISSING');
      assert.equal(f?.before, '***');
      assert.ok(!both(r).includes(SECRET));
    });
  }
  it('leaves a path, an e-mail address and the labelled form as before (control)', () => {
    assert.equal(movedUserinfoMask('docs/a@b'), null);
    assert.equal(movedUserinfoMask('/team@example.com'), null);
    assert.equal(movedUserinfoMask('jane@example.com'), null);
    assert.equal(movedUserinfoMask(`user:${SECRET}@example.com/p`), null);
    assert.equal(movedUserinfoMask(`/user:${SECRET}@example.com/p`), null);
  });
});

describe('n6: a base that hides user information', () => {
  const hiding = [`https://CORP${BS}erik:${SECRET}@example.com/dir/`, `https://example.com${BS}erik:${SECRET}@host.example/`];
  for (const b of hiding) {
    it(`shows relative links as written and the base masked: ${JSON.stringify(b)}`, () => {
      const r = run(source('a.html', '<main><p><a href="rel/x">L</a></p></main>', b), source('a.md', '[L](rel/y)\n', b), { mode: 'offline', strict: false });
      const f = r.findings.find((x) => x.code === 'LINK_TARGET_CHANGED');
      assert.equal(f?.before, 'rel/x');
      assert.equal(f?.after, 'rel/y');
      assert.equal(JSON.parse(renderJson(r)).sources.html.baseUrl, 'https://***/');
      assert.ok(!both(r).includes(SECRET));
    });
  }
  it('reads a document <base href> as it was written', () => {
    const html = `<html><head><base href="https://CORP${BS}erik:${SECRET}@example.com/d/"></head><body><main><p><a href="rel/x">L</a></p></main></body></html>`;
    const r = run(source('a.html', html, 'https://example.com/'), source('a.md', '[L](rel/y)\n', 'https://example.com/'), { mode: 'offline', strict: false });
    assert.equal(r.findings.find((x) => x.code === 'LINK_TARGET_CHANGED')?.before, 'rel/x');
    assert.ok(!both(r).includes(SECRET));
  });
  it('keeps the comparison: the two relative targets still differ', () => {
    const b = hiding[0]!;
    const r = run(source('a.html', '<main><p><a href="rel/x">L</a></p></main>', b), source('a.md', '[L](rel/x)\n', b), { mode: 'offline', strict: false });
    assert.equal(r.findings.filter((x) => x.code.startsWith('LINK_')).length, 0);
  });
  it('resolves against an ordinary base as before (control)', () => {
    const r = run(source('a.html', '<main><p><a href="rel/x">L</a></p></main>', 'https://example.com/dir/'), source('a.md', '[L](rel/y)\n', 'https://example.com/dir/'), { mode: 'offline', strict: false });
    const f = r.findings.find((x) => x.code === 'LINK_TARGET_CHANGED');
    assert.equal(f?.before, 'https://example.com/dir/rel/x');
    assert.equal(f?.after, 'https://example.com/dir/rel/y');
  });
  it('masks --base-url in the text and JSON reports of the command line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-rerun-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.html'), '<main><p><a href="rel/x">L</a></p></main>');
      fs.writeFileSync(path.join(dir, 'a.md'), '[L](rel/y)\n');
      for (const format of ['text', 'json']) {
        let out = '';
        const io = { stdout: (s: string) => { out += s; }, stderr: (s: string) => { out += s; } };
        await main(['--html-file', path.join(dir, 'a.html'), '--markdown-file', path.join(dir, 'a.md'), '--base-url', hiding[0]!, '--format', format], io);
        assert.ok(out.includes('https://***'), format);
        assert.ok(!out.includes(SECRET), format);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('masks a meta.baseUrl that a library caller passes as it is', () => {
    const b = hiding[0]!;
    const r = run(source('a.html', '<main><p>x</p></main>', b, b), source('a.md', 'x\n', b, b), { mode: 'offline', strict: false });
    assert.equal(JSON.parse(renderJson(r)).sources.markdown.baseUrl, 'https://***/');
    assert.ok(!both(r).includes(SECRET));
  });
});

describe('URL mode: a followed redirect whose Location reads as user information', () => {
  const host = 'parity.test';
  let server: http.Server;
  let port = 0;
  const resolver: Resolver = async (h) => {
    if (h === host) return [{ address: '127.0.0.1', family: 4 }];
    if (h === 'private-name.test') return [{ address: '192.168.1.10', family: 4 }];
    throw new Error(`ENOTFOUND ${h}`);
  };
  const options = (accept: string): FetchOptions => ({ accept, timeoutMs: 3000, maxBytes: 1 << 20, resolver, testAllowHosts: [host] });
  const url = (p: string) => `http://${host}:${port}${p}`;
  before(async () => {
    server = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      const go = (location: string) => { res.writeHead(302, { location }); res.end(); };
      if (p === '/start') return go(`user_name:${SECRET}@example.com/page`);
      if (p === '/start2') return go(`CORP${BS}erik:${SECRET}@example.com/p`);
      if (p === '/reset') return go(`user_name:${SECRET}@example.com/x`);
      if (p.endsWith('/x')) return go('/clean');
      if (p === '/loop') return go(`:${SECRET}@e.com/loop`);
      if (p.endsWith('/loop')) return go('loop');
      if (p === '/toprivate') return go(`user_name:${SECRET}@x/next`);
      if (p.endsWith('/next')) return go('http://private-name.test/');
      if (p === '/nolocstart') return go(`user_name:${SECRET}@x/noloc`);
      if (p.endsWith('/noloc')) { res.writeHead(302); return res.end(); }
      if (p === '/manystart') return go(`user_name:${SECRET}@x/m1`);
      if (p.endsWith('/m1')) return go('m2');
      if (p === '/toscheme') return go(`user:${SECRET}@host.example/p`);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<main><p><a href="rel/x">L</a></p></main>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

  it('returns shownFinalUrl with the scheme and //***', async () => {
    for (const p of ['/start', '/start2']) {
      const r = await fetchUrl(url(p), options('text/html'));
      assert.equal(r.shownFinalUrl, 'http://***/', p);
      assert.ok(r.finalUrl.includes(SECRET), 'the unmasked address is kept for resolution');
    }
  });
  it('names the address as http://*** in an error after such a hop', async () => {
    for (const [p, kind] of [['/loop', 'redirect_loop'], ['/toprivate', 'blocked'], ['/nolocstart', 'protocol'], ['/manystart', 'too_many_redirects']] as const) {
      await assert.rejects(fetchUrl(url(p), { ...options('text/html'), ...(p === '/manystart' ? { maxRedirects: 1 } : {}) }), (e: unknown) => {
        assert.ok(e instanceof FetchError);
        assert.equal(e.kind, kind);
        assert.ok(!(e.url + e.message).includes(SECRET), p);
        return true;
      });
    }
  });
  it('shows the final address, the base and the links masked in the command line report', async () => {
    for (const format of ['text', 'json']) {
      let out = '';
      const io = { stdout: (s: string) => { out += s; }, stderr: (s: string) => { out += s; } };
      await main(['--url', url('/start'), '--markdown-url', url('/start'), '--format', format], io, { fetch: (u, o) => fetchUrl(u, { ...o, resolver, testAllowHosts: [host] }) });
      assert.ok(out.includes('http://***/'), format);
      assert.ok(!out.includes(SECRET), format);
    }
  });
  it('masks a typed --url that the parser reads as a host, a port and a path (L1 of the ninth check)', async () => {
    const typed = `http://${host}:${port}${BS}erik:${SECRET}@other.example/p`;
    const r = await fetchUrl(typed, options('text/html'));
    assert.equal(r.shownFinalUrl, 'http://***/');
    for (const format of ['text', 'json']) {
      let out = '';
      const io = { stdout: (s: string) => { out += s; }, stderr: (s: string) => { out += s; } };
      await main(['--url', typed, '--markdown-url', typed, '--format', format], io, { fetch: (u, o) => fetchUrl(u, { ...o, resolver, testAllowHosts: [host] }) });
      assert.ok(out.includes('http://***/'), format);
      assert.ok(!out.includes(SECRET), format);
    }
  });
  it('keeps the mark through a later root path, since the result is still read from the hidden chain', async () => {
    const r = await fetchUrl(url('/reset'), options('text/html'));
    assert.equal(r.shownFinalUrl, 'http://***/');
  });
  it('masks a refused user:secret@host/path, as a Location or as a --url, in the error (tenth check)', async () => {
    const check = (e: unknown) => {
      assert.ok(e instanceof FetchError);
      assert.equal(e.kind, 'protocol');
      assert.equal(e.url, 'user:***@host.example/p');
      assert.ok(!(e.url + e.message).includes(SECRET));
      return true;
    };
    await assert.rejects(fetchUrl(url('/toscheme'), options('text/html')), check);
    await assert.rejects(fetchUrl(`user:${SECRET}@host.example/p`, options('text/html')), check);
  });
  it('masks a --url value of these shapes in the error (F2 of the seventh check)', async () => {
    for (const bad of [`CORP${BS}erik:${SECRET}@host.example/p`, `:${SECRET}@host.example/p`]) {
      await assert.rejects(fetchUrl(bad, options('text/html')), (e: unknown) => {
        assert.ok(e instanceof FetchError);
        assert.equal(e.kind, 'invalid_url');
        assert.ok(!(e.url + e.message).includes(SECRET), bad);
        return true;
      });
    }
  });
  it('sets no shownFinalUrl for an ordinary redirect (control)', async () => {
    const plain = http.createServer((req, res) => {
      if (req.url === '/r') { res.writeHead(302, { location: '/page?k=v' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<main><p>x</p></main>');
    });
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    const p2 = (plain.address() as AddressInfo).port;
    try {
      const r = await fetchUrl(`http://${host}:${p2}/r`, options('text/html'));
      assert.equal(r.shownFinalUrl, undefined);
      assert.equal(r.finalUrl, `http://${host}:${p2}/page?k=v`);
    } finally {
      plain.closeAllConnections();
      await new Promise<void>((r) => plain.close(() => r()));
    }
  });
});
