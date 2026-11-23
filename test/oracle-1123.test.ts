// An absolute oracle for the masking (0.2.43): a seeded generator writes user information in many forms, puts it in
// every place a report or an error can repeat it, and asserts that the made-up password never appears in the text or
// the JSON output. It does not compare two versions, so a leak that both versions share is found too. The shapes
// that the README names as shown on purpose are classified in documentedShown() and counted, not asserted. The test
// is light by default; ORACLE_CASES and ORACLE_SEED widen and move it (the larger runs of the release use them).
// No request leaves the machine: the URL mode talks to a loopback server through an injected resolver.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { main } from '../src/cli.js';
import { fetchUrl, type Resolver } from '../src/fetch.js';
import { renderJson, renderText } from '../src/report.js';
import { run, type SourceInput } from '../src/run.js';

const SEED = Number(process.env['ORACLE_SEED'] ?? 1123);
const CASES = Number(process.env['ORACLE_CASES'] ?? 60);
const BS = String.fromCharCode(92);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Form {
  edge: string;
  scheme: string | null;
  sep: string;
  domain: boolean;
  user: string;
  pwPrefix: string;
  pwMid: string;
  host: string;
  tail: string;
  secret: string;
  /** The password is digits only, so a difference between the two sides is a number the report must not show. */
  numeric: boolean;
}

const SCHEMES = ['https', 'HTTP', 'HtTpS', 'ftp', 'ws', 'wss', 'file', 'gopher', 'foo', 'git+ssh', 'sip', 'my_app', 'ht tps', null, null, null];
const SEPS = ['//', '//', BS + BS, '/' + BS, BS + '/', '/', BS, '', '///'];
const EDGES = ['', '', '', '', '\u3000', '\u00a0', '\u2003', '\ufeff', '\u200b', '\ufffd', ' ', '\t', '\u0085', '\u180e'];
const USERS = ['erik', 'erik', 'a.b-c', '', 'user_name', 'erik@corp'];
const PW_PREFIX = ['', '', '', '', '/', '1/', ' ', '\u00a0', '\t', '\t', '\u3000', '\u2003'];
const PW_MID = ['', '', '', '#', '?', ' ', BS, '%40', '&amp', '=', '?x=', '#x=1', '[', ']', '\u3000'];
const HOSTS = ['host.example', 'host.example', 'host.example', 'www.host.example', '127.0.0.1', 'host.example:8080', 'localhost', '[::1]', 'host.example.', 'hostname', 'h\u00f4st.example'];
const TAILS = ['', '/p', '/p', '/a/b?x=1', '/p?k=v#frag', '?k=v', '#a=b', '/'];

function makeForm(next: () => number, id: number): Form {
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(next() * a.length)]!;
  const numeric = next() < 0.3;
  return {
    numeric,
    edge: pick(EDGES),
    scheme: pick(SCHEMES),
    sep: pick(SEPS),
    domain: next() < 0.12,
    user: pick(USERS),
    pwPrefix: pick(PW_PREFIX),
    pwMid: pick(PW_MID),
    host: pick(HOSTS),
    tail: pick(TAILS),
    secret: numeric ? String(1000000 + Math.floor(next() * 8999999)) : `CNRYP${id.toString(16)}x${Math.floor(next() * 0xffff).toString(16)}`,
  };
}

function compose(f: Form): string {
  const pw = f.pwPrefix + f.secret + f.pwMid;
  return `${f.edge}${f.scheme === null ? '' : f.scheme + ':'}${f.sep}${f.domain ? 'CORP' + BS : ''}${f.user}:${pw}@${f.host}${f.tail}`;
}

type Position = 'htmlText' | 'mdText' | 'mdAutolink' | 'htmlHref' | 'mdLink' | 'baseUrl' | 'timeoutMs' | 'selector' | 'htmlFile' | 'location' | 'numText' | 'numLink';

/**
 * The shapes the README names as shown on purpose, so the oracle does not call them leaks. Only what the "Limits of the
 * method" paragraph names counts: a password that starts with "/" or with digits and "/"; a plain space or a no-break
 * space right after the colon; a relative path "/user:password@host"; a scheme-less "user:password@host.example" with
 * no path, query or fragment behind the host and a host name of the scheme-less kind (and one with a bracketed IPv6
 * address, a trailing dot, no dot or a letter outside ASCII, which the scheme-less rule does not read); an address
 * scheme such as mailto; and, in running text only, a scheme-less password that holds white space.
 */
function documentedShown(f: Form, pos: Position): string | null {
  if (f.scheme === 'sip') return 'address scheme';
  const text = pos === 'htmlText' || pos === 'mdText' || pos === 'mdAutolink' || pos === 'numText';
  // A password of digits only that is followed by white space reads as a port and text (README, limits).
  if (f.numeric && /[ \u3000]/.test(f.pwMid)) return 'digits and white space';
  const md = pos === 'mdText' || pos === 'mdAutolink' || pos === 'mdLink' || pos === 'numText' || pos === 'numLink';
  // Markdown turns a backslash that stands before an ASCII punctuation mark into that mark before anything is read.
  if (md && /\\[!-\/:-@\[-`{-~]/.test(compose(f))) return 'Markdown backslash escape';
  if (f.scheme === null && f.sep === '/') return 'relative path';
  // White space in a password is read in running text only after "://" or a leading "//", and with no backslash domain.
  if (text && /[ \u3000]/.test(f.pwMid) && !(f.sep === '//' && !f.domain)) return 'white space in a password in running text';
  if (f.pwPrefix === '/' || f.pwPrefix === '1/') return 'password starts with / or digits and /';
  if (f.pwPrefix === ' ' || f.pwPrefix === '\u00a0' || f.pwPrefix === '\u3000' || f.pwPrefix === '\u2003') return 'space right after the colon';
  // The text of a block has turned a tab into a space before anything is read.
  if (f.pwPrefix === '\t' && text) return 'space right after the colon';
  // In running text the white space or invisible character at the start is dropped from the excerpt, so the word that
  // remains is the scheme-less one and the same limit holds with it.
  if (f.scheme === null && f.sep === '' && (f.edge === '' || text || f.edge === ' ' || f.edge === '\t') && !f.domain && f.user !== '' && !f.user.includes('@')) {
    if (f.tail === '') return 'scheme-less address with no delimiter behind the host';
    if (/[^\x00-\x7f]/.test(f.host) || f.host.endsWith('.') || f.host === 'hostname' || f.host.startsWith('[')) return 'scheme-less address with a host the rule does not read';
    if ((pos === 'htmlText' || pos === 'mdText' || pos === 'mdAutolink') && /[ \u3000]/.test(f.pwMid)) return 'scheme-less password with white space in running text';
  }
  return null;
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const source = (file: string, body: string): SourceInput => ({
  meta: { kind: 'file', file, bytes: body.length, baseUrl: 'https://example.com/dir/page' },
  body,
  base: 'https://example.com/dir/page',
});

async function cli(argv: string[], deps?: Parameters<typeof main>[2]): Promise<string> {
  let out = '';
  const io = { stdout: (s: string) => { out += s; }, stderr: (s: string) => { out += s; } };
  await main(argv, io, deps);
  return out;
}

const leaks = (out: string, secret: string) => out.toLowerCase().includes(secret.toLowerCase());

describe('absolute masking oracle (seeded)', () => {
  const host = 'parity.test';
  let server: http.Server;
  let port = 0;
  const locations = new Map<string, string>();
  const resolver: Resolver = async (h) => {
    if (h === host) return [{ address: '127.0.0.1', family: 4 }];
    throw new Error(`ENOTFOUND ${h}`);
  };
  const deps = { fetch: (u: string, o: Parameters<typeof fetchUrl>[1]) => fetchUrl(u, { ...o, resolver, testAllowHosts: [host] }) };
  before(async () => {
    server = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      const loc = locations.get(p);
      if (loc !== undefined) {
        res.writeHead(302, { location: loc });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<main><p>x</p></main>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

  it(`never shows the password: ${CASES} forms, seed ${SEED}`, async () => {
    const next = rng(SEED);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-oracle-'));
    const htmlFile = path.join(dir, 'a.html');
    const mdFile = path.join(dir, 'a.md');
    fs.writeFileSync(htmlFile, '<main><p>x</p></main>');
    fs.writeFileSync(mdFile, 'x\n');
    const found: string[] = [];
    const counts: Record<string, number> = {};
    let checked = 0;
    let documented = 0;
    let leakTotal = 0;
    const check = (f: Form, pos: Position, out: string, written: string) => {
      checked++;
      if (!leaks(out, f.secret)) return;
      if (documentedShown(f, pos) !== null) {
        documented++;
        return;
      }
      leakTotal++;
      counts[pos] = (counts[pos] ?? 0) + 1;
      if (found.length < Number(process.env['ORACLE_SHOW'] ?? 40)) found.push(`${pos} ${JSON.stringify(written)}`);
    };
    try {
      for (let i = 0; i < CASES; i++) {
        const f = makeForm(next, i);
        const s = compose(f);
        // HTML text against different Markdown text, so the excerpts of the findings carry the text.
        {
          const r = run(source('a.html', `<main><p>See ${escHtml(s)} now</p></main>`), source('a.md', 'See it\n'), { mode: 'offline', strict: false });
          check(f, 'htmlText', renderJson(r) + renderText(r), s);
        }
        // A password of digits only that differs between the two sides: the number finding must leave the values out
        // (the finding code is the same as before; only the values are not shown).
        if (f.numeric) {
          const f2: Form = { ...f, secret: String(((Number(f.secret) - 1000000 + 1234567) % 8999999) + 1000000) };
          const s2 = compose(f2);
          const r = run(source('a.html', `<main><p>See ${escHtml(s)} now</p></main>`), source('a.md', `See ${s2} now\n`), { mode: 'offline', strict: false });
          const out = renderJson(r) + renderText(r);
          check(f, 'numText', out, s);
          check(f2, 'numText', out, s2);
          const r2 = run(source('a.html', `<main><p>x <a href="${escHtml(s)}">L</a></p></main>`), source('a.md', `x [L](<${s2.replace(/[\r\n<>]/g, '')}>)\n`), { mode: 'offline', strict: false });
          const out2 = renderJson(r2) + renderText(r2);
          check(f, 'numLink', out2, s);
          check(f2, 'numLink', out2, s2);
        }
        {
          const r = run(source('a.html', '<main><p>See it</p></main>'), source('a.md', `See ${s} now\n`), { mode: 'offline', strict: false });
          check(f, 'mdText', renderJson(r) + renderText(r), s);
        }
        {
          const r = run(source('a.html', '<main><p>See it</p></main>'), source('a.md', `See <${s}> now\n`), { mode: 'offline', strict: false });
          check(f, 'mdAutolink', renderJson(r) + renderText(r), s);
        }
        {
          const r = run(source('a.html', `<main><p>x <a href="${escHtml(s)}">L</a></p></main>`), source('a.md', 'x L\n'), { mode: 'offline', strict: false });
          check(f, 'htmlHref', renderJson(r) + renderText(r), s);
        }
        {
          const r = run(source('a.html', '<main><p>x L</p></main>'), source('a.md', `x [L](<${s.replace(/[\r\n<>]/g, '')}>)\n`), { mode: 'offline', strict: false });
          check(f, 'mdLink', renderJson(r) + renderText(r), s);
        }
        for (const format of ['text', 'json']) {
          check(f, 'baseUrl', await cli(['--html-file', htmlFile, '--markdown-file', mdFile, '--base-url', s, '--format', format]), s);
          check(f, 'timeoutMs', await cli(['--html-file', htmlFile, '--markdown-file', mdFile, '--timeout-ms', s, '--format', format]), s);
          check(f, 'selector', await cli(['--html-file', htmlFile, '--markdown-file', mdFile, '--selector', s, '--format', format]), s);
          // A value that starts with two slashes or backslashes is a UNC path on Windows and would reach the network.
          if (!/^[\s\u0085\u180e\u3000\ufeff\u200b\ufffd]*[\/\\]/.test(s) && !s.startsWith('-')) {
            check(f, 'htmlFile', await cli(['--html-file', s, '--markdown-file', mdFile, '--format', format]), s);
          }
        }
        // The URL mode, for one case in ten (each run starts a worker thread): the form as a Location, with a non-ASCII
        // character written as its UTF-8 bytes, as a server sends it.
        if (i % 10 === 0) {
          locations.set(`/r${i}`, Buffer.from(s.replace(/[\r\n]/g, ''), 'utf8').toString('latin1'));
          for (const format of ['text', 'json']) {
            check(f, 'location', await cli(['--url', `http://${host}:${port}/r${i}`, '--markdown-url', `http://${host}:${port}/r${i}`, '--format', format], deps), s);
          }
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log(`oracle seed ${SEED}: ${CASES} forms, ${checked} outputs checked, ${documented} documented shown, ${leakTotal} leaks ${JSON.stringify(counts)}`);
    assert.equal(leakTotal, 0, found.join('\n'));
  });
});
