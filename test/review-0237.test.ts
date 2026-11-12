// Regression tests for release 0.2.37: a parenthesized user name longer than the scan window stays masked, the meta
// charset prescan follows the HTML standard, expandIPv6 rejects a zero-length "::" fill and malformed groups, a lone
// CR ends a front matter fence line, and the raw --format scan stops at a bare "--".
// A test whose name ends in "(control)" pins behaviour that must not change; the others fail on 0.2.36.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { fetchUrl, type FetchOptions } from '../src/fetch.js';
import { extractMarkdown } from '../src/markdown.js';
import { maskParenUserinfo, redactText } from '../src/normalize.js';
import { expandIPv6, isPublicAddress, isPublicIPv6 } from '../src/netguard.js';
import { CLI } from './helpers.js';

describe('a parenthesized user name past the scan window is masked (fail-closed)', () => {
  it('a 5000-character name followed by a secret leaves no part of the secret', () => {
    const text = `Open https://(${'n'.repeat(5000)}):SYNTHETIC_SECRET@example.test/page today.`;
    const out = maskParenUserinfo(text);
    assert.doesNotMatch(out, /SYNTHETIC_SECRET/);
    assert.equal(out, 'Open https://***@example.test/page today.');
    assert.doesNotMatch(redactText(text), /SYNTHETIC_SECRET/);
  });
  it('a long name with no "@" after it is masked through the end of the extra window, never left whole', () => {
    const out = maskParenUserinfo(`https://(${'n'.repeat(5000)}):SYNTHETIC_SECRET ok`);
    assert.doesNotMatch(out, /SYNTHETIC_SECRET/);
  });
  it('a normal-length name still masks to scheme://***@host (control)', () => {
    assert.equal(maskParenUserinfo('See https://(name):pw@host/x now.'), 'See https://***@host/x now.');
    assert.equal(maskParenUserinfo('See https://(' + 'n'.repeat(300) + '):pw@host/x now.'), 'See https://***@host/x now.');
  });
  it('an open parenthesis followed by ordinary text is left as it is (control)', () => {
    const text = 'link https://(example and more words follow here';
    assert.equal(maskParenUserinfo(text), text);
  });
});

describe('a parenthesized user name at the edges of the scan window is masked (4095 and up)', () => {
  it('every name length around and past the window masks the secret', () => {
    for (const n of [4094, 4095, 4096, 4097, 8192]) {
      const text = 'https://(' + 'a'.repeat(n) + '):SECRETXYZ@host.example/p';
      assert.doesNotMatch(redactText(text), /SECRETXYZ/, String(n));
      assert.equal(maskParenUserinfo(text), 'https://***@host.example/p', String(n));
    }
  });
  it('a name past two windows with no "@" is masked through the end of its token', () => {
    const out = maskParenUserinfo('x https://(' + 'a'.repeat(9000) + '):SECRETXYZ and more');
    assert.doesNotMatch(out, /SECRETXYZ/);
    assert.ok(out.endsWith(' and more'));
  });
});

describe('the meta charset follows the HTML standard prescan', () => {
  type Served = { type?: string; body: Buffer };
  const routes = new Map<string, Served>();
  let server: http.Server;
  let port = 0;
  const E_ACUTE = String.fromCharCode(0xe9);
  const latin1 = (s: string) => Buffer.from(s, 'latin1');
  const options: FetchOptions = {
    accept: 'text/html',
    timeoutMs: 3000,
    maxBytes: 1024 * 1024,
    resolver: async (host) => {
      if (host === 'parity.test') return [{ address: '127.0.0.1', family: 4 }];
      throw new Error(`ENOTFOUND ${host}`);
    },
    testAllowHosts: ['parity.test'],
  };
  const caf = (head: string) => Buffer.concat([latin1(`${head}<p>Caf`), Buffer.from([0xe9]), latin1('.</p>')]);
  const decoded = async (name: string, head: string) => {
    routes.set(`/${name}`, { type: 'text/html', body: caf(head) });
    return (await fetchUrl(`http://parity.test:${port}/${name}`, options)).body.includes(`Caf${E_ACUTE}.`);
  };

  before(async () => {
    server = http.createServer((req, res) => {
      const r = routes.get(req.url ?? '');
      if (!r) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, r.type ? { 'Content-Type': r.type } : {});
      res.end(r.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a ">" inside a quoted attribute value does not end the tag', async () => {
    assert.equal(await decoded('quoted-gt', '<meta content="a>b" charset="windows-1252">'), true);
  });
  it('data-charset is not the charset attribute', async () => {
    assert.equal(await decoded('data-charset', '<meta data-charset="windows-1252">'), false);
  });
  it('a charset inside content without http-equiv content-type is ignored', async () => {
    assert.equal(await decoded('content-only', '<meta name="x" content="text/html; charset=windows-1252">'), false);
    assert.equal(await decoded('equiv-other', '<meta http-equiv="refresh" content="0; charset=windows-1252">'), false);
  });
  it('a charset attribute is read in any position (control)', async () => {
    assert.equal(await decoded('attr-first', '<meta charset=windows-1252>'), true);
    assert.equal(await decoded('attr-late', '<meta name="x" CHARSET = "windows-1252" >'), true);
  });
  it('the http-equiv form is read in either attribute order, case-insensitively (control)', async () => {
    assert.equal(await decoded('equiv-a', '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">'), true);
    assert.equal(await decoded('equiv-b', '<meta content="text/html; charset=iso-8859-1" HTTP-EQUIV="content-type">'), true);
  });
  it('a commented-out declaration is skipped (control)', async () => {
    assert.equal(await decoded('commented', '<!-- <meta charset="windows-1252"> -->'), false);
  });
});

describe('expandIPv6 and the address policy', () => {
  it('a "::" that stands for no group is not an address', () => {
    assert.equal(expandIPv6('1:2:3:4:5:6:7:8::'), null);
    assert.equal(expandIPv6('::1:2:3:4:5:6:7:8'), null);
    assert.equal(expandIPv6('1:2:3:4::5:6:7:8'), null);
  });
  it('a group that is not one to four hexadecimal digits is not an address', () => {
    assert.equal(expandIPv6('2001:4860::1g'), null);
    assert.equal(expandIPv6('2001:4860::12345'), null);
    assert.equal(expandIPv6('2001:4860::+1'), null);
    assert.equal(expandIPv6('2001:4860::1 '), null);
    assert.equal(isPublicIPv6('2001:4860::1g'), false);
    assert.equal(isPublicAddress('2001:4860::1g'), false);
  });
  it('valid forms still expand (control)', () => {
    assert.deepEqual(expandIPv6('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(expandIPv6('1::'), [1, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(expandIPv6('1:2:3:4:5:6:7::'), [1, 2, 3, 4, 5, 6, 7, 0]);
    assert.deepEqual(expandIPv6('::2:3:4:5:6:7:8'), [0, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(expandIPv6('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(expandIPv6('2001:DB8::1%eth0'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(expandIPv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    assert.equal(isPublicIPv6('2606:4700::6810:84e5'), true);
  });
});

describe('front matter fenced with CR-only line breaks', () => {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const doc = ['---', 'title: A', 'tags: b', '---', 'Body text here.', ''];
  it('is stripped under --front-matter strip, with the line count of the fence', () => {
    const e = extractMarkdown(doc.join(CR), { frontMatter: 'strip' });
    assert.ok(e.issues.some((i) => i.code === 'MARKDOWN_FRONT_MATTER_STRIPPED' && i.message.startsWith('Lines 1-4 ')), JSON.stringify(e.issues));
    assert.deepEqual(e.blocks.map((b) => b.text), ['Body text here.']);
  });
  it('is stripped the same way with LF and CRLF (control)', () => {
    for (const eol of [LF, CR + LF]) {
      const e = extractMarkdown(doc.join(eol), { frontMatter: 'strip' });
      assert.ok(e.issues.some((i) => i.code === 'MARKDOWN_FRONT_MATTER_STRIPPED' && i.message.startsWith('Lines 1-4 ')), JSON.stringify(e.issues));
      assert.deepEqual(e.blocks.map((b) => b.text), ['Body text here.']);
    }
  });
  it('is kept under the default mode, with the possible-front-matter warning (control)', () => {
    const e = extractMarkdown(doc.join(CR));
    assert.ok(e.issues.some((i) => i.code === 'MARKDOWN_POSSIBLE_FRONT_MATTER'), JSON.stringify(e.issues));
  });
});

describe('a CRLF pair is one line break in the front matter fence', () => {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const strip = (s: string) => extractMarkdown(s, { frontMatter: 'strip' }).issues.some((i) => i.code === 'MARKDOWN_FRONT_MATTER_STRIPPED');
  it('an empty fence and a "..." fence behave the same with CRLF as with LF', () => {
    for (const form of ['---@---@', '---@...@']) {
      const lf = strip(form.split('@').join(LF));
      assert.equal(strip(form.split('@').join(CR + LF)), lf, form);
    }
  });
  it('CR-only front matter still strips (control)', () => {
    const e = extractMarkdown(['---', 'title: a', '---', 'Hello', ''].join(CR), { frontMatter: 'strip' });
    assert.ok(e.issues.some((i) => i.code === 'MARKDOWN_FRONT_MATTER_STRIPPED'));
    assert.deepEqual(e.blocks.map((b) => b.text), ['Hello']);
  });
});

describe('the raw --format scan stops at a bare "--"', () => {
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  it('a --format json after "--" does not turn an argument error into a JSON report', () => {
    const r = cli(['--url', 'https://', '--', '--format', 'json']);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
    assert.notEqual(r.err, '');
  });
  it('a --format json before "--" still does (control)', () => {
    const r = cli(['--url', 'https://', '--format', 'json', '--']);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).mode, 'url');
  });
});
