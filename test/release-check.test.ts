// Release gate tests (audit finding P2-2). The registry is a fake fetch function; nothing here touches
// the real npm registry and nothing is published.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkRelease, compareTarballs, EXIT_MISMATCH, EXIT_MISSING, EXIT_VERIFIED, main, MAX_WAIT_ATTEMPTS, readTarball, ReleaseCheckError, sha512Integrity, waitForRelease, type FetchLike } from '../tools/release-check.js';
import { ROOT } from './helpers.js';

let tmp: string;
let same1: Buffer;
let same2: Buffer;
let changed: Buffer;

function pack(dir: string, content: string): Buffer {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-pkg', version: '1.0.0', bin: { 'fixture-pkg': 'bin/cli.js' }, files: ['bin/'] }));
  fs.writeFileSync(path.join(dir, 'bin', 'cli.js'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(content)});\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  const out = path.join(dir, 'out');
  fs.mkdirSync(out, { recursive: true });
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', out, '--ignore-scripts'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(path.join(out, 'fixture-pkg-1.0.0.tgz'));
}

before(() => {
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  tmp = fs.mkdtempSync(path.join(ROOT, '.tmp', 'release-'));
  same1 = pack(path.join(tmp, 'a'), 'hello');
  same2 = pack(path.join(tmp, 'b'), 'hello');
  changed = pack(path.join(tmp, 'c'), 'changed');
});
after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // A sandbox without delete permission leaves the temp folder behind; that is not a test failure.
  }
});

function registry(entries: Record<string, { body: Buffer; integrity?: string; status?: number }>, versionStatus = 200, versionBody?: string): FetchLike {
  return async (url) => {
    const make = (status: number, data: Buffer | string) => {
      const b = Buffer.from(data);
      return { status, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), text: async () => b.toString('utf8') };
    };
    if (url.endsWith('/fixture-pkg/1.0.0')) {
      if (versionBody !== undefined) return make(versionStatus, versionBody);
      const e = entries['1.0.0'];
      if (!e) return make(404, '{"error":"Not found"}');
      return make(200, JSON.stringify({ version: '1.0.0', dist: { tarball: 'https://registry.test/fixture-pkg/-/fixture-pkg-1.0.0.tgz', integrity: e.integrity ?? sha512Integrity(e.body) } }));
    }
    if (url.endsWith('/-/fixture-pkg-1.0.0.tgz')) {
      const e = entries['1.0.0']!;
      return make(e.status ?? 200, e.body);
    }
    return make(404, 'no');
  };
}

const base = { name: 'fixture-pkg', version: '1.0.0', registry: 'https://registry.test' };

describe('tarball reader and comparison', () => {
  it('reads an npm pack archive and finds the expected files', () => {
    const entries = readTarball(same1);
    assert.deepEqual(entries.map((e) => e.name), ['package/README.md', 'package/bin/cli.js', 'package/package.json']);
    const cli = entries.find((e) => e.name === 'package/bin/cli.js')!;
    assert.equal(cli.content.toString().includes('hello'), true);
    // The mode is read from the archive as written by npm pack; the executable bit depends on the packing
    // file system, so only its presence as a number is asserted here and its equality in compareTarballs.
    assert.equal(Number.isInteger(cli.mode), true);
  });
  it('treats two packs of the same content as equal and lists concrete differences otherwise', () => {
    assert.deepEqual(compareTarballs(same1, same2), []);
    const diffs = compareTarballs(same1, changed);
    assert.equal(diffs.length, 1);
    assert.match(diffs[0]!, /content differs: package\/bin\/cli\.js/);
  });
});

describe('registry check', () => {
  it('same version and same content: verified, exit 0, registry tarball returned', async () => {
    const r = await checkRelease({ ...base, tarball: same1, fetchFn: registry({ '1.0.0': { body: same2 } }) });
    assert.equal(r.code, EXIT_VERIFIED);
    assert.equal(r.registryTarball?.equals(same2), true);
    assert.match(r.message, /verified/);
  });
  it('same version but different content: mismatch, exit 1, difference named', async () => {
    const r = await checkRelease({ ...base, tarball: same1, fetchFn: registry({ '1.0.0': { body: changed } }) });
    assert.equal(r.code, EXIT_MISMATCH);
    assert.match(r.message, /differs from the local tarball/);
    assert.match(r.message, /package\/bin\/cli\.js/);
    assert.equal(r.registryTarball, undefined);
  });
  it('missing version (404): exit 10, may publish', async () => {
    const r = await checkRelease({ ...base, tarball: same1, fetchFn: registry({}) });
    assert.equal(r.code, EXIT_MISSING);
  });
  it('wrong integrity on the registry record: error, never verified', async () => {
    const bad = registry({ '1.0.0': { body: same2, integrity: sha512Integrity(changed) } });
    await assert.rejects(checkRelease({ ...base, tarball: same1, fetchFn: bad }), (err: unknown) => err instanceof ReleaseCheckError && /integrity mismatch/.test(err.message));
  });
  it('registry errors are errors, not a missing version', async () => {
    await assert.rejects(checkRelease({ ...base, tarball: same1, fetchFn: registry({}, 500, 'boom') }), (err: unknown) => err instanceof ReleaseCheckError && /HTTP 500/.test(err.message));
    await assert.rejects(checkRelease({ ...base, tarball: same1, fetchFn: registry({}, 200, 'not json') }), (err: unknown) => err instanceof ReleaseCheckError && /not JSON/.test(err.message));
    const down: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    await assert.rejects(checkRelease({ ...base, tarball: same1, fetchFn: down }), (err: unknown) => err instanceof ReleaseCheckError && /Registry request failed/.test(err.message));
    await assert.rejects(checkRelease({ ...base, tarball: same1, fetchFn: registry({ '1.0.0': { body: same2, status: 503 } }) }), (err: unknown) => err instanceof ReleaseCheckError && /HTTP 503/.test(err.message));
  });
});

/** A registry whose answers change from call to call: each step is the version record's status, or 'ok'
 * for the real record; tarball requests answer tarballStatus or the body. Counts every request. */
function sequence(steps: Array<number | 'ok'>, body: Buffer, tarballStatus: Array<number> = []): FetchLike & { versionCalls: number; tarballCalls: number } {
  let v = 0;
  let t = 0;
  const f = (async (url: string) => {
    const make = (status: number, data: Buffer | string) => {
      const b = Buffer.from(data);
      return { status, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), text: async () => b.toString('utf8') };
    };
    if (url.endsWith('/fixture-pkg/1.0.0')) {
      const step = steps[Math.min(v, steps.length - 1)]!;
      v++;
      f.versionCalls = v;
      if (step !== 'ok') return make(step, '{"error":"Not found"}');
      return make(200, JSON.stringify({ version: '1.0.0', dist: { tarball: 'https://registry.test/fixture-pkg/-/fixture-pkg-1.0.0.tgz', integrity: sha512Integrity(body) } }));
    }
    const status = tarballStatus[t] ?? 200;
    t++;
    f.tarballCalls = t;
    return make(status, status === 200 ? body : 'no');
  }) as FetchLike & { versionCalls: number; tarballCalls: number };
  f.versionCalls = 0;
  f.tarballCalls = 0;
  return f;
}

describe('waiting after npm publish', () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  const opts = { ...base, attempts: 5, intervalMs: 1000, sleep };

  it('waits out the processing delay: 404, 404, then the same tarball is verified on attempt 3', async () => {
    waits.length = 0;
    const f = sequence([404, 404, 'ok'], same2);
    const r = await waitForRelease({ ...opts, tarball: same1, fetchFn: f });
    assert.equal(r.code, EXIT_VERIFIED);
    assert.equal(r.attempts, 3);
    assert.equal(f.versionCalls, 3);
    assert.deepEqual(waits, [1000, 1000]);
  });

  it('waits out temporary statuses on the record and on the tarball', async () => {
    const f = sequence([503, 429, 'ok', 'ok'], same2, [404, 200]);
    const r = await waitForRelease({ ...opts, tarball: same1, fetchFn: f });
    assert.equal(r.code, EXIT_VERIFIED);
    assert.equal(r.attempts, 4);
  });

  it('a version that never appears fails after the last attempt, never as a missing version', async () => {
    waits.length = 0;
    const f = sequence([404], same2);
    const r = await waitForRelease({ ...opts, attempts: 3, tarball: same1, fetchFn: f });
    assert.equal(r.code, EXIT_MISMATCH);
    assert.match(r.message, /still not available on the registry after 3 attempts 1000 ms apart/);
    assert.equal(f.versionCalls, 3);
    assert.deepEqual(waits, [1000, 1000]);
  });

  it('a content mismatch is not retried', async () => {
    const f = sequence(['ok'], changed);
    const r = await waitForRelease({ ...opts, tarball: same1, fetchFn: f });
    assert.equal(r.code, EXIT_MISMATCH);
    assert.match(r.message, /differs from the local tarball/);
    assert.equal(f.versionCalls, 1);
  });

  it('a wrong integrity, a permanent HTTP error and a failed request are not retried', async () => {
    const wrong: FetchLike = registry({ '1.0.0': { body: same2, integrity: sha512Integrity(changed) } });
    await assert.rejects(waitForRelease({ ...opts, tarball: same1, fetchFn: wrong }), (err: unknown) => err instanceof ReleaseCheckError && /integrity mismatch/.test(err.message));
    const f500 = sequence([500, 'ok'], same2);
    await assert.rejects(waitForRelease({ ...opts, tarball: same1, fetchFn: f500 }), (err: unknown) => err instanceof ReleaseCheckError && /HTTP 500/.test(err.message));
    assert.equal(f500.versionCalls, 1);
    const f403 = sequence([403, 'ok'], same2);
    await assert.rejects(waitForRelease({ ...opts, tarball: same1, fetchFn: f403 }), (err: unknown) => err instanceof ReleaseCheckError && /HTTP 403/.test(err.message));
    assert.equal(f403.versionCalls, 1);
    let calls = 0;
    const down: FetchLike = async () => {
      calls++;
      throw new Error('ECONNRESET');
    };
    await assert.rejects(waitForRelease({ ...opts, tarball: same1, fetchFn: down }), (err: unknown) => err instanceof ReleaseCheckError && /Registry request failed/.test(err.message));
    assert.equal(calls, 1);
  });

  it('caps the attempts and the total wait', async () => {
    const f = sequence(['ok'], same2);
    await assert.rejects(waitForRelease({ ...opts, attempts: MAX_WAIT_ATTEMPTS + 1, tarball: same1, fetchFn: f }), /--attempts must be an integer from 1 to 40/);
    await assert.rejects(waitForRelease({ ...opts, attempts: 0, tarball: same1, fetchFn: f }), /--attempts must be an integer/);
    await assert.rejects(waitForRelease({ ...opts, attempts: 40, intervalMs: 20_000, tarball: same1, fetchFn: f }), /may not exceed 600000 ms/);
  });

  it('the command waits only with --wait-for-publish, and the plain check still exits 10 on a missing version', async () => {
    const file = path.join(tmp, 'same1.tgz');
    fs.writeFileSync(file, same1);
    const args = ['--tarball', file, '--name', 'fixture-pkg', '--version', '1.0.0', '--registry', 'https://registry.test'];
    const plain = await main(args, sequence([404, 'ok'], same2), sleep);
    assert.equal(plain, EXIT_MISSING);
    waits.length = 0;
    const waited = await main([...args, '--wait-for-publish', '--attempts', '4', '--interval-ms', '5'], sequence([404, 404, 'ok'], same2), sleep);
    assert.equal(waited, EXIT_VERIFIED);
    assert.deepEqual(waits, [5, 5]);
    const never = await main([...args, '--wait-for-publish', '--attempts', '2', '--interval-ms', '5'], sequence([404], same2), sleep);
    assert.equal(never, EXIT_MISMATCH);
  });
});

describe('release workflow', () => {
  it('waits after publishing, checks before publishing without waiting, and never republishes an existing version', () => {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    const step = yml.slice(yml.indexOf('- name: Publish to npm unless the registry already has this exact tarball'), yml.indexOf('- name: Create the GitHub release'));
    const checks = [...step.matchAll(/node dist\/tools\/release-check\.js[^\n]*/g)].map((m) => m[0]);
    assert.equal(checks.length, 2);
    assert.equal(checks[0]!.includes('--wait-for-publish'), false, 'the first check decides whether to publish and must answer at once');
    assert.match(checks[1]!, /--wait-for-publish --attempts 20 --interval-ms 15000$/);
    assert.equal((step.match(/npm publish /g) ?? []).length, 1);
    assert.match(step, /if \[ "\$CHECK" -eq 10 \]; then\s+(?:#[^\n]*\n\s+)*npm publish /);
  });
});
