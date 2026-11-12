// Linear-time replacements (0.2.2) for three regular expressions that CodeQL flagged as
// js/polynomial-redos: URL_IN_TEXT and the trailing punctuation pattern in redactText, and the embedded
// IPv4 pattern in expandIPv6. The old expressions are kept here as the reference. The new code must give
// the same answer on every input, and it must stay fast on the inputs that made the old ones slow. 0.2.10 added
// one alternative on purpose, a protocol-relative authority with user information, and the reference below
// carries it as its last branch. 0.2.12 lets a URL go on past ( ) " and ' to the end of its token and gives back
// closing punctuation the sentence owns; the reference carries that as the [^\s<>]* after the alternatives and as
// the trim loop in oldRedactText, and a special scheme with user information behind any number of separators as the
// last branch of the expression.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expandIPv6, isPublicIPv6 } from '../src/netguard.js';
import { excerpt, insideHiddenUrlPart, insideParenUserinfo, maskHref, maskParenUserinfo, redactText, stripControlChars } from '../src/normalize.js';

const OLD_URL_IN_TEXT = /(?:[a-z][a-z0-9+.-]*:\/\/[^\s<>"'()]+|www\.[^\s<>"'()]+|(?<![\w/])\/[^\s<>"'()]*[?#][^\s<>"'()]*|[^\s<>"'()]*\?[\w%.-]+=[^\s<>"'()]*|[\/\\]{2}[^\s<>"'()\/\\?#@]*@[^\s<>"'()]*|(?:https?|ftp|wss?|file):[\/\\]*[^\s<>"'()\/\\?#@]*@[^\s<>"'()]*)/giu;

const OLD_URL_IN_TOKEN = new RegExp(`(?:${OLD_URL_IN_TEXT.source})[^\\s<>]*`, 'giu');

function oldRedactText(text: string): string {
  const pre = maskParenUserinfo(text);
  const out = pre.replace(OLD_URL_IN_TOKEN, (m) => {
    const open = (m.match(/\(/g) ?? []).length;
    let close = (m.match(/\)/g) ?? []).length;
    let end = m.length;
    for (;;) {
      const c = m[end - 1];
      if (c !== undefined && '.,;:!?"\''.includes(c)) end--;
      else if (c === ')' && close > open) {
        close--;
        end--;
      } else break;
    }
    return maskHref(m.slice(0, end)) + m.slice(end);
  });
  return stripControlChars(out);
}

function oldIpv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function oldExpandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = oldIpv4ToInt(v4[1]!);
    s = s.slice(0, -v4[1]!.length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

// Deterministic pseudo-random numbers (mulberry32), so a failing case can be reproduced from its seed.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomText(next: () => number, pieces: readonly string[], maxPieces: number): string {
  const n = Math.floor(next() * (maxPieces + 1));
  let s = '';
  for (let i = 0; i < n; i++) s += pieces[Math.floor(next() * pieces.length)]!;
  return s;
}

// Pieces that exercise every alternative, the delimiters, the i and u flags (U+017F and U+212A fold to s
// and k, U+0130 and U+0131 do not fold to i), whitespace outside ASCII (U+00A0, U+2028), and surrogates,
// paired and alone. Written as escapes so the source shows which character each one is.
const TEXT_PIECES = [
  'a', 'Z', 'w', 'W', 'www.', 'wWw.', 'http', 'https:', 'HTTP:', 'ftp:', 'ws:', 'file:', 'x1', '1', '_', '+', '-', '.', ',', ';', ':', '!', '?', '#', '=', '%', '&', '@', 'u:p@', '\\',
  '/', '//', '://', 'k=v', '?q=1', ' ', '\t', '\n', '<', '>', '"', "'", '(', ')', '\u00a0', '\u2028', '\u017f', '\u212a',
  '\u0130', '\u0131', '\u00e9', '\ud83d\ude00', '\ud83d', '\ude00',
];
const IP_PIECES = ['0', '1', '9', '12', '255', '256', '01', '.', ':', '::', 'a', 'f', 'F', 'ffff', '%', 'eth0', 'x', ' '];

describe('linear-time redaction and address parsing (0.2.2)', () => {
  it('redactText gives the same result as the old expression on random text', () => {
    const next = prng(20260911);
    for (let i = 0; i < 20000; i++) {
      const text = randomText(next, TEXT_PIECES, 24);
      assert.equal(redactText(text), oldRedactText(text), JSON.stringify(text));
    }
  });

  it('redactText still masks every kind of URL-like run', () => {
    const cases = [
      'See https://example.com/a?token=SECRET#frag.',
      'Go to www.example.com/?k=SECRET, then stop',
      'path /docs/page?id=SECRET!',
      'relative page.html?session=SECRET',
      'x1abc://host/?k=SECRET',
      '\u017ftp://host/?k=SECRET',
      '(https://example.com/?k=SECRET)',
      'Open https://(name):SECRET@example.test/page for details.',
    ];
    for (const text of cases) {
      const out = redactText(text);
      assert.equal(out, oldRedactText(text), text);
      assert.doesNotMatch(out, /SECRET/, text);
    }
  });

  it('redactText removes the escape character and leaves the rest of an ANSI sequence as text (0.2.16; the wider C0 and C1 set is pinned in review-1023.test.ts)', () => {
    const text = 'Start \x1b[2J hidden terminal control';
    const out = redactText(text);
    assert.doesNotMatch(out, /\x1b/);
    assert.equal(out, 'Start [2J hidden terminal control');
  });

  // 0.2.37: the new code also rejects a zero-length "::" fill and a group that is not one to four hexadecimal digits,
  // which the reference accepted (parseInt read a valid prefix). Wherever the two differ, the input must have one of
  // those shapes, so every other answer is still the same as before.
  const sameOrRejected = (ip: string): void => {
    const now = expandIPv6(ip);
    const before = oldExpandIPv6(ip);
    if (now === null && before !== null) {
      const groups = ip.toLowerCase().split('%')[0]!.split(':').filter((g) => g !== '');
      const bad = groups.some((g, i) => !(/^[0-9a-f]{1,4}$/.test(g) || (i === groups.length - 1 && /^\d+\.\d+\.\d+\.\d+$/.test(g))));
      const quad = /\d+\.\d+\.\d+\.\d+$/.test(ip.toLowerCase().split('%')[0]!) ? 1 : 0;
      const emptyFill = ip.includes('::') && groups.length + quad >= 8;
      assert.ok(bad || emptyFill, `rejected a valid-looking address: ${JSON.stringify(ip)}`);
    } else {
      assert.deepEqual(now, before, JSON.stringify(ip));
    }
  };

  it('expandIPv6 gives the same result as the old expression on random input', () => {
    const next = prng(3600281);
    for (let i = 0; i < 20000; i++) {
      const ip = randomText(next, IP_PIECES, 12);
      sameOrRejected(ip);
    }
    for (const ip of ['::ffff:127.0.0.1', '::ffff:1.2.3.4.5', '1..2.3.4', '::1.2.3.4.', '64:ff9b::192.0.2.1', '2001:db8::1%eth0']) {
      sameOrRejected(ip);
    }
  });

  it('stays fast on the inputs that made the old expressions quadratic', () => {
    // The old code took about 26 s on 200 000 letters; the limit leaves room for a slow CI runner.
    const N = 200_000;
    const inputs: Array<[string, string]> = [
      ['letters', 'a'.repeat(N)],
      ['letters and digits', 'a1'.repeat(N / 2)],
      ['slashes after dots', '/.'.repeat(N / 2)],
      ['question marks', '?a'.repeat(N / 2)],
      ['many short runs', 'a '.repeat(N / 2)],
      ['url and trailing dots', 'http://a' + '.'.repeat(N) + 'x'],
      // 0.2.12: special schemes whose authorities end at the next one's separator, and a query value with a long
      // tail of parentheses.
      ['special schemes', 'ftp:/https:'.repeat(N / 11)],
      ['special schemes without separators', 'https:'.repeat(N / 6)],
      ['query value and parentheses', 'https://a/?q=' + ')('.repeat(N / 2)],
    ];
    for (const [name, text] of inputs) {
      const t0 = performance.now();
      redactText(text);
      excerpt(text);
      const ms = performance.now() - t0;
      assert.ok(ms < 2000, `${name}: ${ms.toFixed(0)} ms for ${text.length} characters`);
    }
    const t0 = performance.now();
    assert.equal(isPublicIPv6('1'.repeat(N) + '!'), false);
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `digit run: ${ms.toFixed(0)} ms`);
  });
});

// 0.2.31: insideParenUserinfo used to run its regular expression on the whole text, and the search goes on to the
// end of the text when nothing matches, so every bare autolink of a long Markdown file rescanned the rest of the
// file and the total time grew with the square of the size. It now searches a prefix of the text that ends a fixed
// span after the window. The old functions are kept here as the reference: the new one must answer the same on
// every input, and its cost per call must not depend on how long the text is.
const OLD_PAREN_USERINFO_START = /\b([a-z][a-z0-9+.-]{0,31}):\/\/\(/giu;
const OLD_SCAN = 4096;

interface OldParenMatch {
  start: number;
  nameStart: number;
  secretEnd: number;
  end: number;
}

function oldNextParenUserinfo(text: string, from: number): OldParenMatch | null {
  const re = new RegExp(OLD_PAREN_USERINFO_START.source, OLD_PAREN_USERINFO_START.flags);
  re.lastIndex = from;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const nameStart = m.index + m[0].length;
    const nameWindowEnd = Math.min(text.length, nameStart + OLD_SCAN);
    const nameWindow = text.slice(nameStart, nameWindowEnd);
    const close = nameWindow.indexOf(')');
    const stop = nameWindow.search(/[\s(]/);
    if (close < 0 && stop < 0 && nameWindowEnd - nameStart === OLD_SCAN) {
      // 0.2.37: a name that fills the window without a terminator is masked fail-closed, the reference carries it.
      const stopRe = /[@\s<>"']/g;
      stopRe.lastIndex = nameWindowEnd;
      const tailMatch = stopRe.exec(text);
      const atTail = tailMatch !== null && tailMatch[0] === '@';
      const tailSecretEnd = tailMatch === null ? text.length : tailMatch.index;
      return { start: m.index, nameStart, secretEnd: tailSecretEnd, end: atTail ? tailSecretEnd + 1 : tailSecretEnd };
    }
    if (close < 0 || (stop >= 0 && stop < close) || text[nameStart + close + 1] !== ':') {
      re.lastIndex = nameStart;
      continue;
    }
    const secretStart = nameStart + close + 2;
    const secretWindowEnd = Math.min(text.length, secretStart + OLD_SCAN);
    const secretWindow = text.slice(secretStart, secretWindowEnd);
    const stopChar = secretWindow.search(/[@\s()<>"']/);
    const atStop = stopChar >= 0 && secretWindow[stopChar] === '@';
    const secretEnd = stopChar < 0 ? secretWindowEnd : secretStart + stopChar;
    return { start: m.index, nameStart, secretEnd, end: atStop ? secretEnd + 1 : secretEnd };
  }
  return null;
}

function oldInsideParenUserinfo(text: string, at: number): boolean {
  const from = Math.max(0, at - OLD_SCAN);
  const to = Math.min(text.length, at + OLD_SCAN);
  let pos = from;
  while (pos < to) {
    const m = oldNextParenUserinfo(text, pos);
    if (!m || m.start >= to) return false;
    const hiddenStart = m.nameStart - 1;
    if (at >= hiddenStart && at < m.secretEnd) return true;
    pos = m.end;
  }
  return false;
}

describe('insideParenUserinfo is linear and gives the same answers (0.2.31)', () => {
  it('the cost of a call does not grow with the length of the text', () => {
    // Quadratic growth over a 4x input gives only about 12x, which a noisy runner can hide, so the test compares a
    // 64 KB text with a 4 MB one at the same fixed position: the old code scaled with the text (about 62x), the
    // new code does not scale at all. The allowance of 8x plus 100 ms leaves room for a loaded CI runner.
    const line = 'https://example.com/path/to/page?x=1 and some words around it\n';
    const small = line.repeat(Math.ceil(65_536 / line.length));
    const big = line.repeat(Math.ceil(4_194_304 / line.length));
    const CALLS = 300;
    const AT = 100;
    const time = (text: string): number => {
      insideParenUserinfo(text, AT);
      const t0 = performance.now();
      for (let i = 0; i < CALLS; i++) assert.equal(insideParenUserinfo(text, AT), false);
      return performance.now() - t0;
    };
    const tSmall = time(small);
    const tBig = time(big);
    assert.ok(tBig < tSmall * 8 + 100, `${CALLS} calls took ${tSmall.toFixed(1)} ms on ${small.length} characters and ${tBig.toFixed(1)} ms on ${big.length}`);
  });

  it('a Markdown file with many bare autolinks takes near linear time', () => {
    const line = 'https://example.com/p/';
    const build = (n: number): string => {
      let s = '';
      for (let i = 0; i < n; i++) s += line + i + '\n\n';
      return s;
    };
    const run = (text: string): number => {
      const t0 = performance.now();
      let at = 0;
      for (let k = text.indexOf('https://', at); k >= 0; k = text.indexOf('https://', at)) {
        insideHiddenUrlPart(text, k);
        at = k + 8;
      }
      return performance.now() - t0;
    };
    run(build(500));
    const tSmall = run(build(2_000));
    const tBig = run(build(16_000));
    // 8x the links: linear is 8x, the old quadratic code measured 57x. The allowance of 30x leaves room for a loaded
    // runner, where the new code reached 19x under 40 busy processes. A floor of 100 ms keeps a fast machine's timer
    // noise out of the ratio.
    assert.ok(tBig < Math.max(tSmall, 25) * 30 + 100, `2 000 links took ${tSmall.toFixed(0)} ms, 16 000 links took ${tBig.toFixed(0)} ms`);
  });

  // Shapes placed so that the start of a match sits at, just before and just after the end of the window.
  const pad = (n: number): string => ' .'.repeat(Math.ceil(n / 2)).slice(0, n);
  const astral = String.fromCodePoint(0x1f600);
  const crlf = String.fromCharCode(13, 10);

  function agree(text: string, ats: number[], label: string): void {
    for (const at of ats) {
      if (at < 0 || at > text.length) continue;
      assert.equal(insideParenUserinfo(text, at), oldInsideParenUserinfo(text, at), `${label}: at ${at} of ${text.length}`);
    }
  }

  /** Positions around the window edges of a match that starts at `s`, and inside and around the match itself. */
  function around(s: number, len: number): number[] {
    const out: number[] = [];
    for (const base of [s - 4096, s - 4095, s - 4094, s - 4097, s, s + 1, s + 5, s + len, s + len - 1, s + len + 1]) {
      for (const d of [-1, 0, 1]) out.push(base + d);
    }
    return out;
  }

  it('gives the old answer on hand-picked edges', () => {
    const schemes = ['https', 'a'.repeat(32), 'a'.repeat(33), 'x', 'Git+ssh.v2'];
    const names = ['n', 'name', 'n'.repeat(4093), 'n'.repeat(4094), 'n'.repeat(4095), 'n'.repeat(4096), 'a b', 'a(b', ''];
    const secrets = ['s', 's'.repeat(4095), 's'.repeat(4096), 's'.repeat(4097), 's'.repeat(9000)];
    const ends = ['@host/path', ' trailing', '', '(', '"quoted"'];
    for (const startAt of [0, 1, 3000, 4095, 4096, 8300]) {
      for (const scheme of schemes) {
        for (const name of names) {
          for (const secret of secrets) {
            for (const end of ends) {
              if (secret.length > 5000 && name.length > 10 && end !== '@host/path') continue;
              const shape = `${scheme}://(${name}):${secret}${end}`;
              const text = pad(startAt) + shape + pad(300);
              agree(text, around(startAt, shape.length), `${scheme.length}/${name.length}/${secret.length}/${JSON.stringify(end)}/${startAt}`);
            }
          }
        }
      }
    }
  });

  it('gives the old answer when a word character, a line break or a wide character sits at the cuts', () => {
    const body = 'https://(user):secret@host/';
    for (const before of ['x', '1', '_', '-', '.', ' ', astral, 'x' + astral, crlf]) {
      for (const startAt of [4094, 4095, 4096, 4097, 5000]) {
        const text = pad(startAt - before.length) + before + body + pad(9000);
        agree(text, around(startAt, body.length), `before ${JSON.stringify(before)} at ${startAt}`);
      }
    }
    for (const inner of [crlf, '\n', astral, astral + astral, 'e' + String.fromCharCode(0x301), String.fromCharCode(0xd83d)]) {
      const names = `https://(a${inner}b):secret@host/`;
      const secrets = `https://(ab):sec${inner}ret@host/`;
      for (const shape of [names, secrets]) {
        for (const startAt of [10, 4095, 4096, 4097]) {
          const text = pad(startAt) + shape + pad(9000);
          agree(text, around(startAt, shape.length), `${JSON.stringify(inner)} in ${JSON.stringify(shape)} at ${startAt}`);
        }
      }
    }
    // No ")" at all, several shapes in one window, and a shape whose secret never ends.
    const noClose = pad(4000) + 'https://(never closed ' + 'a'.repeat(9000);
    agree(noClose, around(4000, 40), 'no close');
    const several = pad(4090) + 'a://(b):c@h https://(d):e@h ftp://(f):' + 's'.repeat(6000) + ' https://(g):h@i';
    agree(several, around(4090, 60).concat(around(4090 + 12, 60), around(4090 + 40, 60)), 'several');
    const endless = pad(4095) + 'https://(n):' + 's'.repeat(20_000);
    agree(endless, around(4095, 20_000).concat([4095 + 12 + 4096, 4095 + 12 + 4097, 4095 + 12 + 8192]), 'endless secret');
  });

  it('gives the old answer on generated text', () => {
    const next = prng(20261104);
    const pieces = [
      'https://(', 'http://(', 'a://(', 'x', 'xhttps://(', '(', ')', '):', ':', '@', '@h', ' ', crlf, '"', '<', '>', 'name', 'secret', '/', '.', 'z'.repeat(1500),
      'z'.repeat(4096), 'z'.repeat(2500), astral, 'e' + String.fromCharCode(0x301), String.fromCharCode(0xd83d), '://(', 'ftp://(n):s',
    ];
    for (let i = 0; i < 1500; i++) {
      const text = randomText(next, pieces, 40);
      const ats = new Set<number>();
      for (let j = 0; j < 6; j++) ats.add(Math.floor(next() * (text.length + 1)));
      for (let k = text.indexOf('://('); k >= 0; k = text.indexOf('://(', k + 1)) {
        for (const a of around(k, 8)) ats.add(a);
      }
      agree(text, [...ats], `generated #${i} (seed 20261104)`);
    }
  });
});
