// Block alignment between the HTML block list (A) and the Markdown block list (B).
// 1. Exact matches in order (LCS over strict keys) preserve duplicates and order.
// 2. Remaining exact-key blocks are paired as moved blocks (order changed).
// 3. Remaining blocks of the same type are paired by loose-key equality, then by token similarity.
// Everything left is missing (HTML only) or added (Markdown only).

import type { Block } from './model.js';

export interface Pair {
  a: number;
  b: number;
  kind: 'exact' | 'moved' | 'loose' | 'similar';
  similarity: number;
}

export interface Alignment {
  pairs: Pair[];
  unmatchedA: number[];
  unmatchedB: number[];
}

/** paragraph and listItem are one group for alignment: a list rendered as paragraphs is a structure
 * difference, not missing content. */
export function typeGroup(b: Block): string {
  return b.type === 'listItem' ? 'paragraph' : b.type;
}

export function strictKey(b: Block): string {
  const t = b.type === 'code' ? (b.code ?? b.text) : b.text;
  return `${typeGroup(b)} ${t}`;
}

function looseKey(b: Block): string {
  return `${typeGroup(b)} ${b.loose}`;
}

export const SIMILARITY_THRESHOLD = 0.6;
export const UNCERTAIN_THRESHOLD = 0.8;

function tokens(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of s.split(' ')) if (t) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Dice coefficient over word tokens of the loose text. */
export function similarity(a: Block, b: Block): number {
  if (a.loose === '' || b.loose === '') return 0;
  const ta = tokens(a.loose);
  const tb = tokens(b.loose);
  let inter = 0;
  let na = 0;
  let nb = 0;
  for (const [, c] of ta) na += c;
  for (const [, c] of tb) nb += c;
  for (const [t, c] of ta) inter += Math.min(c, tb.get(t) ?? 0);
  return (2 * inter) / (na + nb);
}

function lcs(keysA: string[], keysB: string[]): Array<[number, number]> {
  const n = keysA.length;
  const m = keysB.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = keysA[i] === keysB[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (keysA[i] === keysB[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

export function align(a: Block[], b: Block[]): Alignment {
  const pairs: Pair[] = [];
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const keysA = a.map(strictKey);
  const keysB = b.map(strictKey);

  for (const [i, j] of lcs(keysA, keysB)) {
    pairs.push({ a: i, b: j, kind: 'exact', similarity: 1 });
    usedA.add(i);
    usedB.add(j);
  }

  // Moved blocks: exact key present on both sides but outside the in-order LCS.
  const freeB = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    if (usedB.has(j)) continue;
    const k = keysB[j]!;
    const list = freeB.get(k) ?? [];
    list.push(j);
    freeB.set(k, list);
  }
  for (let i = 0; i < a.length; i++) {
    if (usedA.has(i)) continue;
    const list = freeB.get(keysA[i]!);
    if (list && list.length > 0) {
      const j = list.shift()!;
      pairs.push({ a: i, b: j, kind: 'moved', similarity: 1 });
      usedA.add(i);
      usedB.add(j);
    }
  }

  // Loose-key pairs (formatting or punctuation differences only), in document order.
  const looseB = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    if (usedB.has(j)) continue;
    const k = looseKey(b[j]!);
    const list = looseB.get(k) ?? [];
    list.push(j);
    looseB.set(k, list);
  }
  for (let i = 0; i < a.length; i++) {
    if (usedA.has(i)) continue;
    const list = looseB.get(looseKey(a[i]!));
    if (list && list.length > 0) {
      const j = list.shift()!;
      pairs.push({ a: i, b: j, kind: 'loose', similarity: 1 });
      usedA.add(i);
      usedB.add(j);
    }
  }

  // Similar pairs: greedy best-match by similarity above the threshold, same type only. Ties are broken
  // by document order to keep results deterministic.
  const candidates: Array<{ i: number; j: number; s: number }> = [];
  for (let i = 0; i < a.length; i++) {
    if (usedA.has(i)) continue;
    for (let j = 0; j < b.length; j++) {
      if (usedB.has(j)) continue;
      if (typeGroup(a[i]!) !== typeGroup(b[j]!)) continue;
      const s = similarity(a[i]!, b[j]!);
      if (s >= SIMILARITY_THRESHOLD) candidates.push({ i, j, s });
    }
  }
  candidates.sort((x, y) => y.s - x.s || x.i - y.i || x.j - y.j);
  for (const c of candidates) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    pairs.push({ a: c.i, b: c.j, kind: 'similar', similarity: c.s });
    usedA.add(c.i);
    usedB.add(c.j);
  }

  pairs.sort((x, y) => x.a - y.a || x.b - y.b);
  const unmatchedA: number[] = [];
  const unmatchedB: number[] = [];
  for (let i = 0; i < a.length; i++) if (!usedA.has(i)) unmatchedA.push(i);
  for (let j = 0; j < b.length; j++) if (!usedB.has(j)) unmatchedB.push(j);
  return { pairs, unmatchedA, unmatchedB };
}
