// The command line's time limit also covers parsing and comparison (0.2.29). The Markdown emphasis
// parse is quadratic on unmatched delimiters, and a synchronous parse cannot be interrupted by a timer
// on its own thread, so the step runs in a worker thread that is terminated at --timeout-ms.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CLI, FIXTURES, ROOT } from './helpers.js';

let tmp: string;
let htmlFile: string;
let hostileFile: string;

before(() => {
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  tmp = fs.mkdtempSync(path.join(ROOT, '.tmp', 'deadline-'));
  htmlFile = path.join(tmp, 'page.html');
  hostileFile = path.join(tmp, 'hostile.md');
  fs.writeFileSync(htmlFile, '<main><p>Hello world</p></main>\n');
  // "*a" n times followed by "a*" n times: unmatched emphasis delimiters, quadratic in the parser. 96 KiB takes
  // far longer than the ceiling asserted below on any machine, so a run that is not stopped fails the test.
  const n = (96 * 1024) / 4;
  fs.writeFileSync(hostileFile, '*a'.repeat(n) + 'a*'.repeat(n) + '\n');
});
after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // A sandbox without delete permission leaves the temp folder behind; that is not a test failure.
  }
});

function cli(args: string[]) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - started };
}

describe('--timeout-ms covers parsing and comparison', () => {
  it('stops a hostile Markdown document at the deadline with exit 2', () => {
    const r = cli(['--html-file', htmlFile, '--markdown-file', hostileFile, '--timeout-ms', '400']);
    assert.equal(r.code, 2);
    assert.match(r.err, /Timed out after 400 ms while parsing and comparing/);
    assert.match(r.out, /Result: ERROR/);
    // Deadline plus process and worker start-up. Left unstopped the same run takes about half a minute.
    assert.ok(r.ms < 15000, `took ${r.ms} ms`);
  });

  it('reports the timeout in the JSON report as an error with exit code 2', () => {
    const r = cli(['--html-file', htmlFile, '--markdown-file', hostileFile, '--timeout-ms', '400', '--format', 'json']);
    assert.equal(r.code, 2);
    const report = JSON.parse(r.out) as { summary: { result: string; exitCode: number; error: string } };
    assert.equal(report.summary.result, 'error');
    assert.equal(report.summary.exitCode, 2);
    assert.match(report.summary.error, /Timed out after 400 ms/);
  });

  it('leaves an ordinary pair under the default limit unchanged', () => {
    const dir = path.join(FIXTURES, 'missing-added');
    const r = cli(['--html-file', path.join(dir, 'page.html'), '--markdown-file', path.join(dir, 'page.md'), '--format', 'json']);
    assert.equal(r.code, 1);
    const report = JSON.parse(r.out) as { summary: { result: string; exitCode: number } };
    assert.equal(report.summary.result, 'fail');
    assert.equal(report.summary.exitCode, 1);
  });

  it('does not count the worker start-up against a small --timeout-ms', () => {
    // Starting the thread and loading the parsers takes about 170 ms. The deadline starts when the worker
    // is ready, so 100 ms is ample for a small pair that compares in a few milliseconds (QA 1, Q6).
    const dir = path.join(FIXTURES, 'missing-added');
    const r = cli(['--html-file', path.join(dir, 'page.html'), '--markdown-file', path.join(dir, 'page.md'), '--timeout-ms', '100']);
    assert.doesNotMatch(r.err, /Timed out/);
    assert.equal(r.code, 1);
  });

  it('keeps a RunError of the comparison as the same exit 2 error', () => {
    const empty = path.join(tmp, 'empty.md');
    fs.writeFileSync(empty, '\n');
    const r = cli(['--html-file', htmlFile, '--markdown-file', empty]);
    assert.equal(r.code, 2);
    assert.match(r.err, /Markdown content is empty/);
  });

  it('keeps the worker out of the library core', () => {
    const core = fs.readFileSync(path.join(ROOT, 'src', 'core.ts'), 'utf8');
    assert.doesNotMatch(core, /worker_threads|run-worker|deadline/);
  });
});
