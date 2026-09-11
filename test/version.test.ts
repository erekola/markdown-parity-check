// version.ts carries the tool name and version as literals, so the library entry needs no Node.js import.
// The release workflow reads the version from package.json, so the literals, package.json and the lock
// file root must agree before anything is packed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { TOOL_NAME, TOOL_VERSION } from '../src/version.js';
import { ROOT } from './helpers.js';

describe('version literals', () => {
  it('match package.json and both version fields of the lock file', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
    assert.equal(TOOL_NAME, pkg.name);
    assert.equal(TOOL_VERSION, pkg.version);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages['']?.version, pkg.version);
  });
});
