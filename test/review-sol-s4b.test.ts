// Regression tests for the S4 part B triage (MP-11 to MP-16, MP-18 to MP-21, MP-23 and MP-24): the classification of
// changed marks and symbols, sign reversal on non-ASCII digits, the tie between repeated blocks, the pairing of
// repeated-label links, URL whitespace, the HTML decoder choice, the looksHtml prefix, bracketed IPv6 literals, a
// closed stdout pipe, the import graph through the dependencies, and image parity.
// A test whose name ends in "(control)" pins behaviour that must not change; the others fail on 0.2.33.
// Characters outside ASCII are built with String.fromCodePoint so that no editor or tool can rewrite them.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { builtinModules } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pairLinks } from '../src/compare.js';
import { fetchUrl, FetchError, type FetchOptions } from '../src/fetch.js';
import type { Link } from '../src/model.js';
import { extractNumbers, resolveHref, trimHref } from '../src/normalize.js';
import { deliveryFindings, run, type Report, type SourceInput, type SourceMeta } from '../src/run.js';
import { CLI, FIXTURES, ROOT } from './helpers.js';

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

const input = (body: string): SourceInput => ({ body, base: 'https://example.com/docs/', meta: { kind: 'file', file: 'fixture', bytes: Buffer.byteLength(body) } });

/** File-mode run; the HTML is wrapped in <main> so that the page has a main-content root. */
function check(html: string, md: string, strict = false): Report {
  return run(input(`<main>${html}</main>`), input(md), { mode: 'offline', strict });
}

const loud = (r: Report) => r.findings.filter((f) => f.severity !== 'info').map((f) => f.code);
const all = (r: Report) => r.findings.map((f) => f.code);
const errors = (r: Report) => r.findings.filter((f) => f.severity === 'error').map((f) => f.code);

describe('MP-11: a changed mark or symbol is a text change, not a punctuation change', () => {
  const din = cp(0x926, 0x93f, 0x928);
  const deen = cp(0x926, 0x940, 0x928);
  const pairs: Array<[string, string, string]> = [
    ['a vowel sign on a Devanagari word', din, deen],
    ['a check mark against a cross mark', `Status: ${cp(0x2705)} Approved.`, `Status: ${cp(0x274c)} Approved.`],
    ['a less-or-equal against a greater-or-equal sign', `x ${cp(0x2264)} y`, `x ${cp(0x2265)} y`],
    ['a right arrow against a left arrow', `Go ${cp(0x2192)} next`, `Go ${cp(0x2190)} next`],
    ['a plus against a minus', 'Ready A + B now', 'Ready A - B now'],
  ];
  for (const [name, a, b] of pairs) {
    it(`MP-11 ${name} is TEXT_CHANGED`, () => {
      const r = check(`<p>${a}</p>`, b);
      assert.deepEqual(loud(r), ['TEXT_CHANGED']);
      assert.equal(r.summary.exitCode, 1);
    });
  }
  it('MP-11 the blocks still align, so the symbol change is one text finding and not a missing and an added block', () => {
    const r = check(`<p>Intro.</p><p>Go ${cp(0x2192)} next</p>`, `Intro.\n\nGo ${cp(0x2190)} next`);
    assert.deepEqual(all(r), ['TEXT_CHANGED']);
  });
  it('MP-11 punctuation only stays TEXT_MINOR_CHANGED (control)', () => {
    const r = check('<p>Approved!</p>', 'Approved.');
    assert.deepEqual(all(r), ['TEXT_MINOR_CHANGED']);
    assert.equal(r.summary.exitCode, 0);
  });
  it('MP-11 case only stays TEXT_MINOR_CHANGED (control)', () => {
    assert.deepEqual(all(check('<p>Approved today</p>', 'approved today')), ['TEXT_MINOR_CHANGED']);
  });
  it('MP-11 a typographic apostrophe and a dash stay TEXT_MINOR_CHANGED (control)', () => {
    assert.deepEqual(all(check(`<p>It${cp(0x2019)}s a b${cp(0x2013)}c case</p>`, "It's a b-c case")), ['TEXT_MINOR_CHANGED']);
  });
  it('MP-11 a variation selector after a symbol is not a text change', () => {
    const r = check(`<p>Done ${cp(0x2705)}</p>`, `Done ${cp(0x2705, 0xfe0f)}`);
    assert.ok(!all(r).includes('TEXT_CHANGED'), all(r).join());
    assert.equal(r.summary.exitCode, 0);
  });
  it('MP-11 a zero width joiner in an emoji sequence is still only a minor change (control)', () => {
    const family = cp(0x1f468, 0x200d, 0x1f469);
    const r = check(`<p>Team ${family}</p>`, `Team ${cp(0x1f468, 0x1f469)}`);
    assert.ok(!all(r).includes('TEXT_CHANGED'), all(r).join());
  });
  it('MP-11 identical text passes (control)', () => {
    assert.deepEqual(all(check(`<p>Go ${cp(0x2192)} next</p>`, `Go ${cp(0x2192)} next`)), []);
  });
});

describe('MP-12: a sign reversal on non-ASCII digits is a number change', () => {
  const arabic = cp(0x663);
  const wide = cp(0xff13);
  it('MP-12 minus against plus on an Arabic-Indic digit', () => {
    const r = check(`<p>Temperature -${arabic} C.</p>`, `Temperature +${arabic} C.`);
    assert.deepEqual(loud(r), ['NUMBER_CHANGED']);
    assert.equal(r.summary.exitCode, 1);
  });
  it('MP-12 minus against plus on a fullwidth digit', () => {
    const r = check(`<p>Temperature -${wide} C.</p>`, `Temperature +${wide} C.`);
    assert.deepEqual(loud(r), ['NUMBER_CHANGED']);
  });
  it('MP-12 a changed Arabic-Indic digit is a number change', () => {
    assert.deepEqual(errors(check(`<p>Temperature ${arabic} C.</p>`, `Temperature ${cp(0x664)} C.`)), ['NUMBER_CHANGED']);
  });
  it('MP-12 extractNumbers reads the signed non-ASCII value', () => {
    assert.deepEqual(extractNumbers(`a -${arabic} b +${wide} c`), [`-${arabic}`, `+${wide}`]);
  });
  it('MP-12 the same sign reversal on an ASCII digit (control)', () => {
    assert.deepEqual(loud(check('<p>Temperature -3 C.</p>', 'Temperature +3 C.')), ['NUMBER_CHANGED']);
  });
  it('MP-12 equal signed Arabic-Indic numbers pass (control)', () => {
    assert.deepEqual(all(check(`<p>Temperature -${arabic} C.</p>`, `Temperature -${arabic} C.`)), []);
  });
});

describe('MP-13: a tie between repeated blocks is decided by the link target', () => {
  const two = '<p><a href="/linux">download</a></p><p><a href="/windows">download</a></p>';
  it('MP-13 the Linux block is the missing one when the Markdown keeps the Windows link', () => {
    const r = check(two, '[download](/windows)');
    assert.deepEqual(all(r), ['BLOCK_MISSING']);
    assert.equal(r.findings[0]!.html?.blockIndex, 0);
  });
  it('MP-13 the Windows block is the missing one when the Markdown keeps the Linux link (control)', () => {
    const r = check(two, '[download](/linux)');
    assert.deepEqual(all(r), ['BLOCK_MISSING']);
    assert.equal(r.findings[0]!.html?.blockIndex, 1);
  });
  it('MP-13 two repeated blocks with both links swapped are still two target changes (control)', () => {
    const r = check(two, '[download](/windows)\n\n[download](/linux)');
    assert.deepEqual(all(r), ['LINK_TARGET_CHANGED', 'LINK_TARGET_CHANGED']);
  });
  it('MP-13 repeated blocks without links still pair in order (control)', () => {
    const r = check('<p>same</p><p>same</p><p>other text</p>', 'same\n\nother text');
    assert.deepEqual(all(r), ['BLOCK_MISSING']);
    assert.equal(r.findings[0]!.html?.blockIndex, 1);
  });
});

describe('MP-14: repeated-label links pair in order of occurrence', () => {
  const link = (text: string, target: string): Link => ({ text, rawHref: target, resolved: `https://example.com${target}` });
  it('MP-14 a swap and a gained link report two target changes and one addition', () => {
    const r = check('<p><a href="/a">Download</a> <a href="/b">Download</a> Download</p>', '[Download](/b) [Download](/a) [Download](/c)');
    assert.deepEqual(all(r), ['LINK_ADDED', 'LINK_TARGET_CHANGED', 'LINK_TARGET_CHANGED']);
  });
  it('MP-14 pairLinks pairs the swapped links by position', () => {
    const { pairs, missing, added } = pairLinks([link('Download', '/a'), link('Download', '/b')], [link('Download', '/b'), link('Download', '/a'), link('Download', '/c')]);
    assert.deepEqual(pairs, [[0, 0], [1, 1]]);
    assert.deepEqual(missing, []);
    assert.deepEqual(added, [2]);
  });
  it('MP-14 a link inserted before the others is one addition (control)', () => {
    const { pairs, missing, added } = pairLinks([link('Download', '/a'), link('Download', '/b')], [link('Download', '/x'), link('Download', '/a'), link('Download', '/b')]);
    assert.deepEqual(pairs, [[0, 1], [1, 2]]);
    assert.deepEqual(missing, []);
    assert.deepEqual(added, [0]);
  });
  it('MP-14 a link dropped from the front is one missing link', () => {
    const { pairs, missing, added } = pairLinks([link('Download', '/a'), link('Download', '/b')], [link('Download', '/b')]);
    assert.deepEqual(pairs, [[1, 0]]);
    assert.deepEqual(missing, [0]);
    assert.deepEqual(added, []);
  });
  it('MP-14 a changed target with an extra link is a change and an addition (control)', () => {
    const { pairs, missing, added } = pairLinks([link('Download', '/a'), link('Download', '/b')], [link('Download', '/a'), link('Download', '/c'), link('Download', '/d')]);
    assert.deepEqual(pairs, [[0, 0], [1, 1]]);
    assert.deepEqual(missing, []);
    assert.deepEqual(added, [2]);
  });
  it('MP-14 equal counts with a swap are two target changes (control)', () => {
    const r = check('<p><a href="/a">Download</a> <a href="/b">Download</a> Download</p>', '[Download](/b) [Download](/a) Download');
    assert.deepEqual(all(r), ['LINK_TARGET_CHANGED', 'LINK_TARGET_CHANGED']);
  });
  it('MP-14 equal counts and equal targets pass (control)', () => {
    assert.deepEqual(all(check('<p><a href="/a">Download</a> <a href="/b">Download</a></p>', '[Download](/a) [Download](/b)')), []);
  });
});

describe('MP-15: a moved block that was also edited in its words gets no order finding', () => {
  it('MP-15 a moved block with changed numbers reports the numbers and no order (pins the documented limit)', () => {
    const html = '<p>The alpha plan costs 10 euros per month today.</p><p>The beta plan costs 20 euros per month today.</p>';
    const md = 'The beta plan costs 21 euros per month today.\n\nThe alpha plan costs 11 euros per month today.';
    assert.ok(!all(check(html, md)).includes('ORDER_CHANGED'));
  });
  it('MP-15 a block that moved and changed only in punctuation gets an order finding (control)', () => {
    const html = '<p>The alpha plan costs ten euros per month today.</p><p>The beta plan costs twenty euros per month today.</p>';
    const md = 'The beta plan costs twenty euros per month today!\n\nThe alpha plan costs ten euros per month today.';
    const found = all(check(html, md));
    assert.ok(found.includes('ORDER_CHANGED'), found.join());
  });
  it('MP-15 the README states the narrower rule', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /moved and also changed in its words or numbers[^.]*no order finding/);
  });
});

describe('MP-16: Unicode whitespace in a link target is part of the target', () => {
  const NBSP = cp(0xa0);
  const IDEOGRAPHIC = cp(0x3000);
  const base = 'https://example.com/base/';
  const runWithBase = (html: string, md: string) => run({ ...input(`<main><p>${html}</p></main>`), base }, { ...input(md), base }, { mode: 'offline', strict: true });
  it('MP-16 a trailing no-break space in an HTML href is a changed target', () => {
    assert.deepEqual(all(runWithBase('<a href="/other&#160;">docs</a>', '[docs](/other)')), ['LINK_TARGET_CHANGED']);
  });
  it('MP-16 a leading no-break space is a changed target', () => {
    assert.deepEqual(all(runWithBase(`<a href="${NBSP}/other">docs</a>`, '[docs](/other)')), ['LINK_TARGET_CHANGED']);
  });
  it('MP-16 a leading ideographic space is a changed target', () => {
    assert.deepEqual(all(runWithBase(`<a href="${IDEOGRAPHIC}/other">docs</a>`, '[docs](/other)')), ['LINK_TARGET_CHANGED']);
  });
  it('MP-16 an absolute href with a trailing no-break space is a changed target', () => {
    assert.deepEqual(all(runWithBase('<a href="https://example.com/other&#160;">docs</a>', '[docs](/other)')), ['LINK_TARGET_CHANGED']);
  });
  it('MP-16 resolveHref and trimHref keep the Unicode space and strip the URL standard characters', () => {
    assert.notEqual(resolveHref(`/other${NBSP}`, base), resolveHref('/other', base));
    assert.equal(trimHref(`${NBSP}/x${IDEOGRAPHIC}`), `${NBSP}/x${IDEOGRAPHIC}`);
    assert.equal(trimHref('\t \n/x\r\x01 '), '/x');
    assert.equal(resolveHref('  /other ', base), resolveHref('/other', base));
  });
  it('MP-16 ASCII spaces and controls around an href are still removed (control)', () => {
    assert.deepEqual(all(runWithBase('<a href="  /other ">docs</a>', '[docs](/other)')), []);
    assert.deepEqual(all(runWithBase('<a href="&#9;/other&#10;">docs</a>', '[docs](/other)')), []);
  });
  it('MP-16 a zero width space is a changed target (control)', () => {
    assert.deepEqual(all(runWithBase('<a href="/other&#8203;">docs</a>', '[docs](/other)')), ['LINK_TARGET_CHANGED']);
  });
  it('MP-16 without a base, the unresolved forms with and without a no-break space are not equal', () => {
    const noBase = (body: string): SourceInput => ({ ...input(body), base: null });
    const r = run(noBase('<main><p><a href="/other&#160;">docs</a></p></main>'), noBase('[docs](/other)'), { mode: 'offline', strict: false });
    assert.ok(all(r).includes('LINK_TARGET_CHANGED'), all(r).join());
  });
});

interface Served {
  type?: string;
  body: Buffer;
}

describe('MP-18: the HTML decoder follows the BOM, the header and the meta declaration in that order', () => {
  const routes = new Map<string, Served>();
  let server: http.Server;
  let port = 0;
  const E_ACUTE = String.fromCharCode(0xe9);
  const latin1 = (s: string) => Buffer.from(s, 'latin1');
  const options = (accept: string): FetchOptions => ({
    accept,
    timeoutMs: 3000,
    maxBytes: 1024 * 1024,
    resolver: async (host) => {
      if (host === 'parity.test') return [{ address: '127.0.0.1', family: 4 }];
      throw new Error(`ENOTFOUND ${host}`);
    },
    testAllowHosts: ['parity.test'],
  });
  const body = async (route: string, accept = 'text/html') => (await fetchUrl(`http://parity.test:${port}${route}`, options(accept))).body;

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

  const caf = (head: string) => Buffer.concat([latin1(`${head}<p>Caf`), Buffer.from([0xe9]), latin1('.</p>')]);

  it('MP-18 a meta charset decodes a Latin-1 page whose header names no charset', async () => {
    routes.set('/meta', { type: 'text/html', body: caf('<meta charset="windows-1252">') });
    assert.ok((await body('/meta')).includes(`Caf${E_ACUTE}.`));
  });
  it('MP-18 the http-equiv form of the meta declaration is read as well', async () => {
    routes.set('/equiv', { type: 'text/html', body: caf('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">') });
    assert.ok((await body('/equiv')).includes(`Caf${E_ACUTE}.`));
  });
  it('MP-18 a UTF-8 byte order mark wins over the header charset', async () => {
    routes.set('/bom', { type: 'text/html; charset=windows-1252', body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`<p>Caf${E_ACUTE}.</p>`, 'utf8')]) });
    const text = await body('/bom');
    assert.ok(text.includes(`Caf${E_ACUTE}.`), text);
    assert.ok(!text.includes(cp(0xfeff)) && !text.includes(cp(0xef, 0xbb, 0xbf)), 'the byte order mark is gone');
  });
  it('MP-18 a UTF-16LE byte order mark wins over the header charset', async () => {
    routes.set('/bom16', { type: 'text/html; charset=utf-8', body: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`<p>Caf${E_ACUTE}.</p>`, 'utf16le')]) });
    assert.ok((await body('/bom16')).includes(`Caf${E_ACUTE}.`));
  });
  it('MP-18 the header charset wins over the meta declaration', async () => {
    routes.set('/header-first', { type: 'text/html; charset=windows-1252', body: caf('<meta charset="utf-8">') });
    assert.ok((await body('/header-first')).includes(`Caf${E_ACUTE}.`));
  });
  it('MP-18 an unknown header charset falls through to the meta declaration', async () => {
    routes.set('/unknown-header', { type: 'text/html; charset=no-such-charset', body: caf('<meta charset="windows-1252">') });
    assert.ok((await body('/unknown-header')).includes(`Caf${E_ACUTE}.`));
  });
  it('MP-18 an unknown charset everywhere decodes as UTF-8 and does not throw', async () => {
    routes.set('/unknown-all', { type: 'text/html; charset=no-such-charset', body: Buffer.from(`<meta charset="also-unknown"><p>Caf${E_ACUTE}.</p>`, 'utf8') });
    assert.ok((await body('/unknown-all')).includes(`Caf${E_ACUTE}.`));
  });
  it('MP-18 a meta declaration after the first 1024 bytes is not read', async () => {
    routes.set('/late-meta', { type: 'text/html', body: caf(`<!-- ${'x'.repeat(1100)} --><meta charset="windows-1252">`) });
    assert.ok((await body('/late-meta')).includes(cp(0xfffd)));
  });
  it('MP-18 a meta declaration inside a comment is not read', async () => {
    routes.set('/comment-meta', { type: 'text/html', body: caf('<!-- <meta charset="windows-1252"> -->') });
    assert.ok((await body('/comment-meta')).includes(cp(0xfffd)));
  });
  it('MP-18 UTF-8 with the usual UTF-8 header and meta (control)', async () => {
    routes.set('/utf8', { type: 'text/html; charset=utf-8', body: Buffer.from(`<meta charset="utf-8"><p>Caf${E_ACUTE}.</p>`, 'utf8') });
    assert.ok((await body('/utf8')).includes(`Caf${E_ACUTE}.`));
  });
  it('MP-18 an HTML page with no declaration decodes as UTF-8 (control)', async () => {
    routes.set('/plain-utf8', { type: 'text/html', body: Buffer.from(`<p>Caf${E_ACUTE}.</p>`, 'utf8') });
    assert.ok((await body('/plain-utf8')).includes(`Caf${E_ACUTE}.`));
  });
  it('MP-18 a Markdown response ignores a meta declaration and decodes as UTF-8 (control)', async () => {
    routes.set('/md-meta', { type: 'text/markdown', body: caf('<meta charset="windows-1252">') });
    assert.ok((await body('/md-meta', 'text/markdown')).includes(cp(0xfffd)));
  });
  it('MP-18 a Markdown response still follows its header charset (control)', async () => {
    routes.set('/md-header', { type: 'text/markdown; charset=windows-1252', body: caf('') });
    assert.ok((await body('/md-header', 'text/markdown')).includes(`Caf${E_ACUTE}.`));
  });
});

describe('MP-19: a leading comment, processing instruction or declaration does not hide an HTML page', () => {
  const meta = (contentType: string): SourceMeta => ({ kind: 'url', status: 200, contentType, bytes: 0 });
  const page = '<!doctype html><html><head><title>T</title></head><body><p>x</p></body></html>';
  const isHtml = (body: string) => deliveryFindings(meta('text/markdown'), body).map((f) => f.code);
  it('MP-19 a page without a prefix is reported (control)', () => {
    assert.deepEqual(isHtml(page), ['DELIVERY_MARKDOWN_IS_HTML']);
  });
  it('MP-19 a leading comment before the doctype', () => {
    assert.deepEqual(isHtml(`<!-- generated -->\n${page}`), ['DELIVERY_MARKDOWN_IS_HTML']);
  });
  it('MP-19 several comments before an html element', () => {
    assert.deepEqual(isHtml('<!-- a -->\n<!-- b -->\n<html lang="en"><body>x</body></html>'), ['DELIVERY_MARKDOWN_IS_HTML']);
  });
  it('MP-19 an XML declaration before the doctype', () => {
    assert.deepEqual(isHtml(`<?xml version="1.0"?>\n${page}`), ['DELIVERY_MARKDOWN_IS_HTML']);
  });
  it('MP-19 a byte order mark and white space before a comment', () => {
    assert.deepEqual(isHtml(`${cp(0xfeff)}  \n<!-- c -->${page}`), ['DELIVERY_MARKDOWN_IS_HTML']);
  });
  it('MP-19 Markdown that starts with a comment and goes on with Markdown is not HTML (control)', () => {
    assert.deepEqual(isHtml('<!-- note -->\n# Title\n\nSome text with <b>bold</b>.\n'), []);
  });
  it('MP-19 Markdown that starts with a comment and a raw div is not HTML (control)', () => {
    assert.deepEqual(isHtml('<!-- note -->\n<div>x</div>\n'), []);
  });
  it('MP-19 an unclosed comment hides the rest, so the body is not an HTML page (control)', () => {
    assert.deepEqual(isHtml(`<!-- never closed\n${page}`), []);
  });
  it('MP-19 plain Markdown (control)', () => {
    assert.deepEqual(isHtml('# Title\n\nText.\n'), []);
  });
});

describe('MP-20: a public IPv6 literal URL goes to the address policy and not to DNS', () => {
  interface Spy {
    asked: string[];
    connected: string[];
    options: FetchOptions;
  }
  function spy(testAllowHosts: string[] = []): Spy {
    const asked: string[] = [];
    const connected: string[] = [];
    const agent = new http.Agent();
    // The agent stops the request where it would open a socket, so no packet leaves the machine.
    (agent as unknown as { createConnection: (o: { host?: string; hostname?: string }, cb: (err: Error) => void) => void }).createConnection = (o, cb) => {
      connected.push(String(o.host ?? o.hostname));
      cb(new Error('stopped before connecting'));
    };
    return {
      asked,
      connected,
      options: {
        accept: 'text/html',
        timeoutMs: 2000,
        maxBytes: 1024,
        resolver: async (host) => {
          asked.push(host);
          return [{ address: '93.184.216.34', family: 4 }];
        },
        agent,
        testAllowHosts,
      },
    };
  }
  async function kindOf(url: string, s: Spy): Promise<string> {
    try {
      await fetchUrl(url, s.options);
    } catch (err) {
      assert.ok(err instanceof FetchError, String(err));
      return `${err.kind}: ${err.message}`;
    }
    return 'no error';
  }
  it('MP-20 a public bracketed literal never reaches the resolver and is handed to the socket', async () => {
    const s = spy();
    const result = await kindOf('http://[2606:4700:4700::1111]/', s);
    assert.deepEqual(s.asked, []);
    assert.equal(s.connected.length, 1, result);
    assert.match(s.connected[0]!, /^\[?2606:4700:4700::1111\]?$/);
    assert.doesNotMatch(result, /DNS lookup/);
  });
  it('MP-20 a public IPv4-mapped literal is policy-checked and handed to the socket', async () => {
    const s = spy();
    await kindOf('http://[::ffff:5db8:d822]/', s);
    assert.deepEqual(s.asked, []);
    assert.equal(s.connected.length, 1);
  });
  for (const literal of ['[::1]', '[fd00::1]', '[::ffff:7f00:1]', '[2001:db8::1]', '[fe80::1]']) {
    it(`MP-20 the non-public literal ${literal} is blocked before DNS and before a socket (control)`, async () => {
      const s = spy();
      const result = await kindOf(`http://${literal}/`, s);
      assert.match(result, /^blocked:/);
      assert.deepEqual(s.asked, []);
      assert.deepEqual(s.connected, []);
    });
  }
  it('MP-20 a test-allowed literal skips the policy but still never reaches DNS', async () => {
    const s = spy(['[::1]']);
    await kindOf('http://[::1]/', s);
    assert.deepEqual(s.asked, []);
    assert.equal(s.connected.length, 1);
  });
  it('MP-20 a host name still goes through the resolver and the policy (control)', async () => {
    const s = spy();
    await kindOf('http://public-name.test/', s);
    assert.deepEqual(s.asked, ['public-name.test']);
    assert.equal(s.connected.length, 1);
  });
});

describe('MP-21: a closed stdout pipe ends with exit 2', () => {
  const args = [CLI, '--html-file', path.join(FIXTURES, 'same', 'page.html'), '--markdown-file', path.join(FIXTURES, 'same', 'page.md'), '--front-matter', 'strip', '--format', 'json'];
  it('MP-21 the reader closes the pipe before the report is written', async () => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.doesNotMatch(stderr, /Unhandled 'error' event/);
    assert.equal(code, 2, stderr);
  });
  it('MP-21 a normal run keeps its exit code (control)', () => {
    const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal((JSON.parse(r.stdout) as Report).summary.exitCode, 0);
  });
});

// The import graph of the library entry, followed through the installed dependencies (MP-23). A bare specifier is
// resolved the way a bundler for a worker would: the exports map with the conditions below, then module and main.
describe('MP-23: the import graph of the library entry reaches no Node.js built-in module, dependencies included', () => {
  const CONDITIONS = ['workerd', 'worker', 'browser', 'import', 'module', 'default'];
  const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')]));

  function importsIn(source: string): string[] {
    // Comments are removed first: a JSDoc type such as import('mdast').Nodes is not an import at run time.
    const src = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const out: string[] = [];
    for (const m of src.matchAll(/(?:^|[\n;])\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
    for (const m of src.matchAll(/(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
    for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
    return out;
  }
  const packageName = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);

  /** The first target whose condition a worker bundler matches. */
  function pick(target: unknown): string | null {
    if (typeof target === 'string') return target;
    if (Array.isArray(target)) {
      for (const t of target) {
        const r = pick(t);
        if (r) return r;
      }
      return null;
    }
    if (target && typeof target === 'object') {
      for (const [k, v] of Object.entries(target as Record<string, unknown>)) {
        if (!CONDITIONS.includes(k)) continue;
        const r = pick(v);
        if (r) return r;
      }
    }
    return null;
  }

  function findPackage(name: string, fromDir: string): string | null {
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (path.dirname(dir) === dir) return null;
    }
  }

  function nearestPackageJson(fromDir: string): string | null {
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
      if (path.dirname(dir) === dir) return null;
    }
  }

  interface Walk {
    files: Set<string>;
    packages: Set<string>;
    bad: string[];
    unresolved: string[];
  }

  function resolveBare(spec: string, fromFile: string): string | null {
    const name = packageName(spec);
    const sub = spec.slice(name.length);
    const dir = findPackage(name, path.dirname(fromFile));
    if (!dir) return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { exports?: unknown; module?: string; main?: string };
    let rel: string | null = null;
    if (pkg.exports !== undefined) {
      const ex = pkg.exports;
      const map: Record<string, unknown> = ex && typeof ex === 'object' && !Array.isArray(ex) && Object.keys(ex).some((k) => k.startsWith('.')) ? (ex as Record<string, unknown>) : { '.': ex };
      rel = pick(map[`.${sub}`]);
    } else if (sub === '') {
      rel = pkg.module ?? pkg.main ?? 'index.js';
    } else {
      rel = `.${sub}`;
    }
    return rel ? path.resolve(dir, rel) : null;
  }

  function resolveHash(spec: string, fromFile: string): string | null {
    const dir = nearestPackageJson(path.dirname(fromFile));
    if (!dir) return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { imports?: Record<string, unknown> };
    const target = pick(pkg.imports?.[spec]);
    if (!target) return null;
    return target.startsWith('.') ? path.resolve(dir, target) : resolveBare(target, fromFile);
  }

  /** Follows relative imports, bare imports (into node_modules) and #imports from an entry file. */
  function walk(entry: string, follow = true): Walk {
    const out: Walk = { files: new Set(), packages: new Set(), bad: [], unresolved: [] };
    const visit = (file: string) => {
      if (out.files.has(file)) return;
      out.files.add(file);
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const pkgDir = nearestPackageJson(path.dirname(file));
      if (pkgDir && file.includes(`${path.sep}node_modules${path.sep}`)) out.packages.add(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).name as string);
      for (const spec of importsIn(fs.readFileSync(file, 'utf8'))) {
        if (spec.startsWith('node:') || BUILTINS.has(packageName(spec))) {
          out.bad.push(`${rel} imports ${spec}`);
        } else if (spec.startsWith('.')) {
          visit(path.resolve(path.dirname(file), spec));
        } else if (!follow) {
          continue;
        } else {
          const target = spec.startsWith('#') ? resolveHash(spec, file) : resolveBare(spec, file);
          if (target && fs.existsSync(target)) visit(target);
          else out.unresolved.push(`${rel} imports ${spec}`);
        }
      }
    };
    visit(entry);
    return out;
  }

  it('MP-23 the walk reaches the entry file of every declared dependency and finds no built-in import', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const w = walk(path.join(ROOT, 'dist', 'src', 'core.js'));
    assert.deepEqual(w.bad, []);
    assert.deepEqual(w.unresolved, []);
    for (const name of Object.keys(pkg.dependencies)) assert.ok(w.packages.has(name), `${name} was not reached through the import graph`);
    assert.ok([...w.files].filter((f) => f.includes(`${path.sep}node_modules${path.sep}`)).length >= 40, 'the walk entered only a few dependency files');
  });

  let tmp: string;
  before(() => {
    fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
    tmp = fs.mkdtempSync(path.join(ROOT, '.tmp', 's4b-'));
  });
  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // A sandbox without delete permission leaves the temp folder behind; that is not a test failure.
    }
  });

  it('MP-23 a node: import planted at the end of a copied dependency file is found (negative control)', () => {
    const copy = path.join(tmp, 'planted');
    fs.mkdirSync(path.join(copy, 'node_modules'), { recursive: true });
    const probe = path.join(copy, 'entry.js');
    fs.writeFileSync(probe, "import 'domhandler';\n");
    // Copy domhandler and what it reaches from the real tree; the real node_modules stays untouched.
    const real = walk(path.join(ROOT, 'node_modules', 'domhandler', 'dist', 'index.js'));
    for (const name of real.packages) {
      const from = findPackage(name, ROOT)!;
      fs.cpSync(from, path.join(copy, 'node_modules', name), { recursive: true });
    }
    const clean = walk(probe);
    assert.deepEqual(clean.bad, [], 'the copy is clean before the plant');
    const inner = path.join(copy, 'node_modules', 'domhandler', 'dist', 'node.js');
    assert.ok(fs.existsSync(inner));
    fs.appendFileSync(inner, "\nimport 'node:fs';\n");
    const planted = walk(probe);
    assert.equal(planted.bad.length, 1, planted.bad.join());
    assert.match(planted.bad[0]!, /domhandler\/dist\/node\.js imports node:fs/);
    // The walk of the real tree is untouched by the plant.
    assert.ok(!fs.readFileSync(path.join(ROOT, 'node_modules', 'domhandler', 'dist', 'node.js'), 'utf8').includes('node:fs'));
  });
  it('MP-23 a walk that stops at the bare specifier does not see the planted import (why the old test missed it)', () => {
    const planted = path.join(tmp, 'planted', 'entry.js');
    assert.ok(fs.existsSync(planted), 'the previous test builds the planted copy');
    assert.deepEqual(walk(planted, false).bad, []);
  });
  it('MP-23 a conditional export for Node alone is not followed (no false positive)', () => {
    const dir = path.join(tmp, 'conditional');
    const pkgDir = path.join(dir, 'node_modules', 'twofaced');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'twofaced', type: 'module', exports: { '.': { node: './node.js', default: './web.js' } }, imports: { '#env': { node: './env-node.js', default: './env-web.js' } } }));
    fs.writeFileSync(path.join(pkgDir, 'node.js'), "import 'node:fs';\n");
    fs.writeFileSync(path.join(pkgDir, 'web.js'), "import '#env';\n");
    fs.writeFileSync(path.join(pkgDir, 'env-node.js'), "import 'node:net';\n");
    fs.writeFileSync(path.join(pkgDir, 'env-web.js'), 'export const env = 1;\n');
    fs.writeFileSync(path.join(dir, 'entry.js'), "import 'twofaced';\n");
    const w = walk(path.join(dir, 'entry.js'));
    assert.deepEqual(w.bad, []);
    assert.deepEqual(w.unresolved, []);
    assert.ok([...w.files].some((f) => f.endsWith('web.js')) && [...w.files].some((f) => f.endsWith('env-web.js')));
  });
});

describe('MP-24: image parity is compared by alt text only', () => {
  const html = (alt: string) => `<p>See <img src="/blue.svg" alt="${alt}"> now.</p>`;
  it('MP-24 the same alt text with another address passes', () => {
    assert.deepEqual(all(check(html('Blue bird'), 'See ![Blue bird](/another.svg) now.')), []);
  });
  it('MP-24 a changed alt text is TEXT_CHANGED', () => {
    assert.deepEqual(errors(check(html('Blue bird'), 'See ![Red bird](/blue.svg) now.')), ['TEXT_CHANGED']);
  });
  it('MP-24 a missing alt text on the Markdown image is TEXT_CHANGED', () => {
    assert.deepEqual(errors(check(html('Blue bird'), 'See ![](/blue.svg) now.')), ['TEXT_CHANGED']);
  });
  it('MP-24 a missing alt text on the HTML image is TEXT_CHANGED', () => {
    assert.deepEqual(errors(check('<p>See <img src="/blue.svg"> now.</p>', 'See ![Blue bird](/blue.svg) now.')), ['TEXT_CHANGED']);
  });
  it('MP-24 a reference-style Markdown image counts like an inline one', () => {
    assert.deepEqual(all(check(html('Blue bird'), 'See ![Blue bird][b] now.\n\n[b]: /blue.svg')), []);
    assert.deepEqual(errors(check(html('Blue bird'), 'See ![Red bird][b] now.\n\n[b]: /blue.svg')), ['TEXT_CHANGED']);
  });
  it('MP-24 a raw HTML image in the Markdown counts like a Markdown image', () => {
    assert.deepEqual(all(check(html('Blue bird'), 'See <img src="/other.svg" alt="Blue bird"> now.')), []);
  });
  it('MP-24 an identical image passes (control)', () => {
    assert.deepEqual(all(check(html('Blue bird'), 'See ![Blue bird](/blue.svg) now.')), []);
  });
});
