// Release gate tests (audit finding P2-2). The registry is a fake fetch function; nothing here touches
// the real npm registry and nothing is published.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkRelease, compareTarballs, EXIT_MISMATCH, EXIT_MISSING, EXIT_VERIFIED, readTarball, ReleaseCheckError, sha512Integrity, type FetchLike } from '../tools/release-check.js';
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
