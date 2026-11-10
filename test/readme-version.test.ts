// The README's release check and install pin name a version. Each one must be the version in
// package.json, because a version bump once left half of them behind and the instruction then asked
// a reader to compare the wrong tag (found by an outside re-check). The test also demands at
// least one mention of each form, so it cannot pass on an empty match.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ROOT } from './helpers.js';

const FORMS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'Tag `vX.Y.Z`', pattern: /Tag `v(\d+\.\d+\.\d+)`/g },
  { name: 'commits/vX.Y.Z', pattern: /commits\/v(\d+\.\d+\.\d+)/g },
  { name: 'markdown-parity-check@X.Y.Z', pattern: /markdown-parity-check@(\d+\.\d+\.\d+)/g },
  { name: 'example output sentence "run with version X.Y.Z on"', pattern: /run with version (\d+\.\d+\.\d+) on/g },
  { name: 'example output header "markdown-parity-check X.Y.Z (offline mode)"', pattern: /^markdown-parity-check (\d+\.\d+\.\d+) \(offline mode\)$/gm },
];

describe('README versions', () => {
  it('every tag, commit and install version is the package.json version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    for (const form of FORMS) {
      const found = [...readme.matchAll(form.pattern)].map((m) => m[1]);
      assert.ok(found.length > 0, `README names no version in the form ${form.name}`);
      for (const v of found) assert.equal(v, pkg.version, `README names ${v} in the form ${form.name}, package.json is ${pkg.version}`);
    }
  });
});
