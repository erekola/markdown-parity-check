// Resource limits of the comparison (audit finding P2-1, 2026-09-10). The alignment work is bounded by
// the product of the block counts and by the number of similarity candidates; exceeding either is a
// controlled exit 2, never a pass and never a silently truncated comparison. Every case here stays far
// below the memory the limits protect against: the largest table allocated is 2 001 by 2 001 cells.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { align, AlignmentLimitError, checkAlignmentLimit, MAX_ALIGNMENT_PAIRS, MAX_SIMILARITY_CANDIDATES } from '../src/align.js';
import { compare } from '../src/compare.js';
import type { Block, Extraction } from '../src/model.js';
import type { Report } from '../src/run.js';
import { CLI, ROOT } from './helpers.js';

function paragraph(text: string, blockIndex: number): Block {
  return { type: 'paragraph', text, loose: text.toLowerCase(), links: [], numbers: text.match(/\d+/g) ?? [], location: { line: blockIndex + 1, blockIndex } };
}

function paragraphs(count: number, text: (i: number) => string): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < count; i++) out.push(paragraph(text(i), i));
  return out;
}

function extraction(blocks: Block[]): Extraction {
  return { blocks, strategy: 'test', confidence: 'high', notes: [], issues: [] } as unknown as Extraction;
}

let tmp: string;
before(() => {
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  tmp = fs.mkdtempSync(path.join(ROOT, '.tmp', 'limits-'));
});
after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // A sandbox without delete permission leaves the temp folder behind; that is not a test failure.
  }
});

describe('alignment limit', () => {
  it('is 4 000 000 block pairs and is checked on the product, not on either side alone', () => {
    assert.equal(MAX_ALIGNMENT_PAIRS, 4_000_000);
    assert.doesNotThrow(() => checkAlignmentLimit(2000, 2000));
    assert.doesNotThrow(() => checkAlignmentLimit(100_000, 40));
    assert.doesNotThrow(() => checkAlignmentLimit(1, 4_000_000));
    assert.throws(() => checkAlignmentLimit(2001, 2000), AlignmentLimitError);
    assert.throws(() => checkAlignmentLimit(100_000, 41), (err: unknown) => err instanceof AlignmentLimitError && /100000 HTML blocks by 41 Markdown blocks is 4100000 block pairs/.test(err.message));
  });
  it('completes a 2 000 by 2 000 comparison at the limit with duplicates, order and numbers intact', () => {
    const a = paragraphs(2000, (i) => `Paragraph ${i % 1990} with value ${i % 7}`);
    const b = paragraphs(2000, (i) => `Paragraph ${i % 1990} with value ${i % 7}`);
    const r = compare(extraction(a), extraction(b), { bothBases: true });
    assert.equal(r.coverage.htmlMatched, 2000);
    assert.equal(r.coverage.markdownMatched, 2000);
    assert.equal(r.findings.filter((f) => f.severity === 'error').length, 0);
    // Duplicate handling is unchanged: one occurrence removed on one side is one missing block.
    const short = compare(extraction(a), extraction(b.slice(0, 1999)), { bothBases: true });
    assert.equal(short.findings.filter((f) => f.code === 'BLOCK_MISSING').length, 1);
    // A number change inside an aligned block is still a numeric finding at that block.
    const changed = b.map((blk, i) => (i === 1500 ? paragraph(blk.text.replace(/value \d/, 'value 9'), i) : blk));
    const num = compare(extraction(a), extraction(changed), { bothBases: true });
    assert.equal(num.findings.some((f) => f.code === 'NUMBER_CHANGED' && f.html?.blockIndex === 1500), true);
  });
  it('refuses an asymmetric pair above the limit before allocating anything', () => {
    const many = paragraphs(100_001, (i) => `Line ${i}`);
    const few = paragraphs(40, (i) => `Line ${i}`);
    assert.throws(() => align(few, many), AlignmentLimitError);
    assert.throws(() => compare(extraction(few), extraction(many), { bothBases: true }), AlignmentLimitError);
    assert.throws(() => align(many, few), AlignmentLimitError);
  });
  it('stops the similarity search when the candidate list would exceed its limit', () => {
    assert.equal(MAX_SIMILARITY_CANDIDATES, 1_000_000);
    // No exact or loose matches: every HTML block resembles every Markdown block above the threshold,
    // so 1 001 by 1 000 free blocks would produce 1 001 000 candidates.
    const a = paragraphs(1001, (i) => `alpha beta gamma delta epsilon zeta html ${i}`);
    const b = paragraphs(1000, (i) => `alpha beta gamma delta epsilon zeta markdown ${i}`);
    assert.throws(() => align(a, b), (err: unknown) => err instanceof AlignmentLimitError && /similar block pairs/.test(err.message));
    // The same shape below the limit completes and pairs every block as similar.
    const small = align(a.slice(0, 300), b.slice(0, 300));
    assert.equal(small.pairs.length, 300);
    assert.equal(small.pairs.every((p) => p.kind === 'similar'), true);
    assert.deepEqual(small.unmatchedA, []);
  });
});

describe('alignment limit through the CLI', () => {
  it('exits 2 with a clear text and JSON error, not a pass', () => {
    const n = 2001;
    const htmlPath = path.join(tmp, 'big.html');
    const mdPath = path.join(tmp, 'big.md');
    const htmlBody = Array.from({ length: n }, (_, i) => `<p>Paragraph ${i}</p>`).join('\n');
    fs.writeFileSync(htmlPath, `<!DOCTYPE html><html><body><main>${htmlBody}</main></body></html>`);
    fs.writeFileSync(mdPath, Array.from({ length: n }, (_, i) => `Paragraph ${i}\n`).join('\n'));
    const args = ['--html-file', htmlPath, '--markdown-file', mdPath];
    const text = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(text.status, 2);
    assert.match(text.stderr, /Comparison limit exceeded: 2001 HTML blocks by 2001 Markdown blocks/);
    assert.match(text.stdout, /Result: ERROR\. Comparison limit exceeded/);
    const json = spawnSync(process.execPath, [CLI, ...args, '--format', 'json'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(json.status, 2);
    const report = JSON.parse(json.stdout) as Report;
    assert.equal(report.summary.result, 'error');
    assert.equal(report.summary.exitCode, 2);
    assert.match(report.summary.error ?? '', /Comparison limit exceeded/);
    assert.deepEqual(report.findings, []);
  });
});
