// Linear-time replacements (0.2.2) for three regular expressions that CodeQL flagged as
// js/polynomial-redos: URL_IN_TEXT and the trailing punctuation pattern in redactText, and the embedded
// IPv4 pattern in expandIPv6. The old expressions are kept here as the reference. The new code must give
// the same answer on every input, and it must stay fast on the inputs that made the old ones slow.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expandIPv6, isPublicIPv6 } from '../src/netguard.js';
import { excerpt, maskHref, redactText } from '../src/normalize.js';

const OLD_URL_IN_TEXT = /(?:[a-z][a-z0-9+.-]*:\/\/[^\s<>"'()]+|www\.[^\s<>"'()]+|(?<![\w/])\/[^\s<>"'()]*[?#][^\s<>"'()]*|[^\s<>"'()]*\?[\w%.-]+=[^\s<>"'()]*)/giu;

function oldRedactText(text: string): string {
  return text.replace(OLD_URL_IN_TEXT, (m) => {
    const trail = /[.,;:!?]+$/.exec(m)?.[0] ?? '';
    return maskHref(m.slice(0, m.length - trail.length)) + trail;
  });
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
  'a', 'Z', 'w', 'W', 'www.', 'wWw.', 'http', 'x1', '1', '_', '+', '-', '.', ',', ';', ':', '!', '?', '#', '=', '%', '&',
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
    ];
    for (const text of cases) {
      const out = redactText(text);
      assert.equal(out, oldRedactText(text), text);
      assert.doesNotMatch(out, /SECRET/, text);
    }
  });

  it('expandIPv6 gives the same result as the old expression on random input', () => {
    const next = prng(3600281);
    for (let i = 0; i < 20000; i++) {
      const ip = randomText(next, IP_PIECES, 12);
      assert.deepEqual(expandIPv6(ip), oldExpandIPv6(ip), JSON.stringify(ip));
    }
    for (const ip of ['::ffff:127.0.0.1', '::ffff:1.2.3.4.5', '1..2.3.4', '::1.2.3.4.', '64:ff9b::192.0.2.1', '2001:db8::1%eth0']) {
      assert.deepEqual(expandIPv6(ip), oldExpandIPv6(ip), ip);
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
