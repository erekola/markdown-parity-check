// Block alignment between the HTML block list (A) and the Markdown block list (B).
// 1. Exact matches in order (LCS over strict keys) preserve duplicates and order.
// 2. Remaining exact-key blocks are paired as moved blocks (order changed).
// 3. Remaining blocks in the same typeGroup (paragraphs and list items share one) are paired by loose-key
//    equality, then by token similarity.
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

/** Upper bound on the alignment work, as the product of the HTML and Markdown block counts. The LCS
 * table holds (n+1)*(m+1) Uint32 cells, 16 MiB at the limit (2 000 by 2 000 blocks), and the similarity
 * search visits at most n*m block pairs. Above the limit the comparison stops with an error before any
 * table is allocated, instead of growing without bound with the page size. */
export const MAX_ALIGNMENT_PAIRS = 4_000_000;

/** Upper bound on the similarity candidates kept for the greedy best-match pass. Only pairs at or above
 * SIMILARITY_THRESHOLD are kept, so this is reached only when a large share of the free blocks on both
 * sides resemble each other. */
export const MAX_SIMILARITY_CANDIDATES = 1_000_000;

/** Resource limits of the alignment. The defaults are the CLI's. A host with a smaller CPU or memory
 * budget, such as a Cloudflare Worker, passes lower values through RunOptions.limits. Exceeding any of
 * them is an AlignmentLimitError, reported as an error result, never as a pass or a truncated
 * comparison. */
export interface AlignmentLimits {
  /** Upper bound on the product of the HTML and Markdown block counts. */
  maxAlignmentPairs: number;
  /** Upper bound on the similarity candidates kept for the greedy best-match pass. */
  maxSimilarityCandidates: number;
  /** Upper bound on token lookups in the similarity search, summed over every block pair it visits.
   * Unbounded by default; the block pair limit already bounds it for the CLI. */
  maxSimilarityWork: number;
}

export const DEFAULT_LIMITS: Readonly<AlignmentLimits> = Object.freeze({
  maxAlignmentPairs: MAX_ALIGNMENT_PAIRS,
  maxSimilarityCandidates: MAX_SIMILARITY_CANDIDATES,
  maxSimilarityWork: Number.POSITIVE_INFINITY,
});

function resolveLimits(limits: Partial<AlignmentLimits> | undefined): AlignmentLimits {
  const out = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== 'number' || Number.isNaN(v) || v <= 0) throw new TypeError(`Alignment limit ${k} must be a positive number (got ${String(v)}).`);
  }
  return out;
}

/** Thrown when the comparison would exceed a documented resource limit. The caller reports it as an
 * error result (exit 2), never as a pass or a silently truncated comparison. */
export class AlignmentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlignmentLimitError';
  }
}

interface TokenCounts {
  counts: Map<string, number>;
  total: number;
}

function tokens(s: string): TokenCounts {
  const counts = new Map<string, number>();
  let total = 0;
  for (const t of s.split(' ')) {
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
    total++;
  }
  return { counts, total };
}

function dice(ta: TokenCounts, tb: TokenCounts): number {
  if (ta.total === 0 || tb.total === 0) return 0;
  let inter = 0;
  for (const [t, c] of ta.counts) inter += Math.min(c, tb.counts.get(t) ?? 0);
  return (2 * inter) / (ta.total + tb.total);
}

/** Dice coefficient over word tokens of the loose text. */
export function similarity(a: Block, b: Block): number {
  if (a.loose === '' || b.loose === '') return 0;
  return dice(tokens(a.loose), tokens(b.loose));
}

/** Checks the block counts against the block pair limit (MAX_ALIGNMENT_PAIRS by default) before any
 * work is done. */
export function checkAlignmentLimit(htmlBlocks: number, markdownBlocks: number, maxPairs: number = MAX_ALIGNMENT_PAIRS): void {
  const pairs = htmlBlocks * markdownBlocks;
  if (pairs > maxPairs) {
    throw new AlignmentLimitError(
      `Comparison limit exceeded: ${htmlBlocks} HTML blocks by ${markdownBlocks} Markdown blocks is ${pairs} block pairs, above the limit of ${maxPairs}. Narrow the HTML content with --selector or compare a smaller page.`,
    );
  }
}

function lcs(keysA: string[], keysB: string[], maxPairs: number): Array<[number, number]> {
  const n = keysA.length;
  const m = keysB.length;
  checkAlignmentLimit(n, m, maxPairs);
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

export function align(a: Block[], b: Block[], limits?: Partial<AlignmentLimits>): Alignment {
  const lim = resolveLimits(limits);
  checkAlignmentLimit(a.length, b.length, lim.maxAlignmentPairs);
  const pairs: Pair[] = [];
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const keysA = a.map(strictKey);
  const keysB = b.map(strictKey);

  for (const [i, j] of lcs(keysA, keysB, lim.maxAlignmentPairs)) {
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

  // Similar pairs: greedy best match by similarity within the same typeGroup, keeping scores at or above
  // SIMILARITY_THRESHOLD. Ties are broken by document order to keep results deterministic. Token counts are
  // computed once per block, and the candidate list is bounded by the configured maxSimilarityCandidates
  // (MAX_SIMILARITY_CANDIDATES by default).
  const freeA: number[] = [];
  const freeBs: number[] = [];
  for (let i = 0; i < a.length; i++) if (!usedA.has(i)) freeA.push(i);
  for (let j = 0; j < b.length; j++) if (!usedB.has(j)) freeBs.push(j);
  const tokensA = new Map<number, TokenCounts>();
  const tokensB = new Map<number, TokenCounts>();
  for (const i of freeA) tokensA.set(i, tokens(a[i]!.loose));
  for (const j of freeBs) tokensB.set(j, tokens(b[j]!.loose));
  const candidates: Array<{ i: number; j: number; s: number }> = [];
  // Token lookups so far. dice() walks the HTML block's distinct tokens once per visited pair, so this
  // is the work the search does, and a host with a small CPU budget bounds it through the limits.
  let work = 0;
  for (const i of freeA) {
    const ta = tokensA.get(i)!;
    if (ta.total === 0) continue;
    const ga = typeGroup(a[i]!);
    for (const j of freeBs) {
      if (typeGroup(b[j]!) !== ga) continue;
      work += ta.counts.size;
      if (work > lim.maxSimilarityWork) {
        throw new AlignmentLimitError(
          `Comparison limit exceeded: the similarity search among ${freeA.length} unmatched HTML blocks and ${freeBs.length} unmatched Markdown blocks needs more than ${lim.maxSimilarityWork} token comparisons. Narrow the HTML content with --selector or compare a smaller page.`,
        );
      }
      const s = dice(ta, tokensB.get(j)!);
      if (s < SIMILARITY_THRESHOLD) continue;
      if (candidates.length >= lim.maxSimilarityCandidates) {
        throw new AlignmentLimitError(
          `Comparison limit exceeded: more than ${lim.maxSimilarityCandidates} similar block pairs among ${freeA.length} unmatched HTML blocks and ${freeBs.length} unmatched Markdown blocks. Narrow the HTML content with --selector or compare a smaller page.`,
        );
      }
      candidates.push({ i, j, s });
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
