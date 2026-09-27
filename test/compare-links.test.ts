// The indexed link pairing and the counted number diff of 0.2.12 must give the same answer as the scans they
// replaced (outside review 2026-09-26, F09). The old code is kept here as the reference and compared on random
// input, the way test/linear.test.ts does for the redaction. 0.2.13 changed the pairing on purpose (F08: links whose
// text occurs equally often on both sides pair in order; F11: what is left pairs by loose text), and the reference
// carries both as plain loops around the old scan.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffNumbers, pairLinks } from '../src/compare.js';
import type { Link } from '../src/model.js';
import { looseNormalize, relativeHrefRelation } from '../src/normalize.js';

function oldSameTarget(a: Link, b: Link): boolean {
  if (a.resolved !== null && b.resolved !== null) return a.resolved === b.resolved;
  if (a.resolved === null && b.resolved === null) return relativeHrefRelation(a.rawHref, b.rawHref) === 'same';
  return a.rawHref.trim() === b.rawHref.trim();
}

function oldPairLinks(hLinks: Link[], mLinks: Link[]) {
  const n = (links: Link[], text: string) => links.filter((l) => l.text === text).length;
  const remaining = mLinks.map((l, i) => ({ l, i }));
  const pairs: Array<[number, number]> = [];
  let missing: number[] = [];
  hLinks.forEach((hl, hi) => {
    let idx: number;
    if (n(hLinks, hl.text) === n(mLinks, hl.text)) {
      // 0.2.13 step 1: the k-th link with this text pairs with the k-th.
      const k = hLinks.slice(0, hi).filter((l) => l.text === hl.text).length;
      const target = mLinks.map((l, i) => ({ l, i })).filter((x) => x.l.text === hl.text)[k]!.i;
      idx = remaining.findIndex((r) => r.i === target);
    } else {
      idx = remaining.findIndex((r) => r.l.text === hl.text && oldSameTarget(hl, r.l));
      if (idx < 0) idx = remaining.findIndex((r) => r.l.text === hl.text);
    }
    if (idx < 0) {
      missing.push(hi);
      return;
    }
    pairs.push([hi, remaining.splice(idx, 1)[0]!.i]);
  });
  // 0.2.13 step 3: what is left pairs by loose text, in order.
  const still: number[] = [];
  for (const hi of missing) {
    const k = looseNormalize(hLinks[hi]!.text);
    const idx = k === '' ? -1 : remaining.findIndex((r) => looseNormalize(r.l.text) === k);
    if (idx < 0) still.push(hi);
    else pairs.push([hi, remaining.splice(idx, 1)[0]!.i]);
  }
  missing = still;
  pairs.sort((x, y) => x[0] - y[0]);
  return { pairs, missing, added: remaining.map((r) => r.i).sort((x, y) => x - y) };
}

function oldDiffNumbers(a: string[], b: string[]): { before: string[]; after: string[] } | null {
  if (a.length === b.length && a.every((v, i) => v === b[i])) return null;
  const remB = [...b];
  const before: string[] = [];
  for (const v of a) {
    const k = remB.indexOf(v);
    if (k >= 0) remB.splice(k, 1);
    else before.push(v);
  }
  const remA = [...a];
  const after: string[] = [];
  for (const v of b) {
    const k = remA.indexOf(v);
    if (k >= 0) remA.splice(k, 1);
    else after.push(v);
  }
  if (before.length === 0 && after.length === 0) return { before: a, after: b };
  return { before, after };
}

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

// Link shapes that exercise every branch of sameTarget: resolved and unresolved, raw hrefs that differ only in
// surrounding space, relative forms that are the same under every base (./a and a) and forms that are not.
const TEXTS = ['a', 'b', 'Download', 'download', 'DOWNLOAD!', '***'];
const SHAPES: Array<Omit<Link, 'text'>> = [
  { rawHref: '/x', resolved: 'https://e.test/x' },
  { rawHref: ' /x ', resolved: 'https://e.test/x' },
  { rawHref: '/y', resolved: 'https://e.test/y' },
  { rawHref: 'https://e.test/x', resolved: 'https://e.test/x' },
  { rawHref: '/x', resolved: null },
  { rawHref: ' /x', resolved: null },
  { rawHref: './a', resolved: null },
  { rawHref: 'a', resolved: null },
  { rawHref: '../a', resolved: null },
  { rawHref: 'a', resolved: 'https://e.test/a' },
  { rawHref: 'http://[bad', resolved: null },
];

describe('indexed link pairing and counted number diff (0.2.12)', () => {
  it('pairLinks gives the same pairs as the old scans on random link lists', () => {
    const next = prng(20260926);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
    const list = () => Array.from({ length: Math.floor(next() * 9) }, () => ({ text: pick(TEXTS), ...pick(SHAPES) }));
    for (let i = 0; i < 5000; i++) {
      const h = list();
      const m = list();
      assert.deepEqual(pairLinks(h, m), oldPairLinks(h, m), JSON.stringify({ h, m }));
    }
  });

  it('diffNumbers gives the same result as the old scans on random lists', () => {
    const next = prng(3600281);
    const list = () => Array.from({ length: Math.floor(next() * 10) }, () => String(Math.floor(next() * 5)));
    for (let i = 0; i < 20000; i++) {
      const a = list();
      const b = list();
      assert.deepEqual(diffNumbers(a, b), oldDiffNumbers(a, b), JSON.stringify({ a, b }));
    }
  });
});
