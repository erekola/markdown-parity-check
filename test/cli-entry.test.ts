// The test of the entry-point check of the command (0.2.39): Node gives process.argv[1] as the path that was typed, so
// `node dist/src/cli` has no .js extension in it while the module file has one. Up to 0.2.38 the two did not compare
// equal and the command exited 0 without a word. The check is a pure function of two paths, so it is tested here on
// POSIX and on Windows shaped paths, whichever system runs the test: the path functions are passed in.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isEntryPoint } from '../src/cli.js';

const same = { resolve: (p: string) => p, realpath: (p: string) => p, caseInsensitive: false };

describe('isEntryPoint', () => {
  it('POSIX paths: with and without the extension, and other files', () => {
    const file = '/opt/pkg/dist/src/cli.js';
    assert.equal(isEntryPoint('/opt/pkg/dist/src/cli.js', file, same), true);
    assert.equal(isEntryPoint('/opt/pkg/dist/src/cli', file, same), true);
    assert.equal(isEntryPoint('/opt/pkg/dist/src/other', file, same), false);
    assert.equal(isEntryPoint('/opt/pkg/dist/src/cli.jsx', file, same), false);
    assert.equal(isEntryPoint('/opt/pkg/dist/src/CLI', file, same), false, 'a POSIX file system tells the cases apart');
    assert.equal(isEntryPoint('/opt/pkg/dist/src/cli/', file, same), false);
    assert.equal(isEntryPoint(undefined, file, same), false);
    assert.equal(isEntryPoint('', file, same), false);
  });

  it('Windows paths: with and without the extension, any case', () => {
    const file = 'C:\\pkg\\dist\\src\\cli.js';
    const win = { ...same, caseInsensitive: true };
    assert.equal(isEntryPoint('C:\\pkg\\dist\\src\\cli.js', file, win), true);
    assert.equal(isEntryPoint('C:\\pkg\\dist\\src\\cli', file, win), true);
    assert.equal(isEntryPoint('c:\\PKG\\dist\\src\\CLI', file, win), true);
    assert.equal(isEntryPoint('C:\\pkg\\dist\\src\\other', file, win), false);
    assert.equal(isEntryPoint('C:\\pkg\\dist\\src\\cli', file, { ...same, caseInsensitive: false }), true);
    assert.equal(isEntryPoint('c:\\pkg\\dist\\src\\cli', file, { ...same, caseInsensitive: false }), false);
  });

  it('a link or a short name is followed through realpath, with the extension added last', () => {
    const real = (p: string) => (p === '/usr/bin/mpc' ? '/opt/pkg/dist/src/cli.js' : p);
    assert.equal(isEntryPoint('/usr/bin/mpc', '/opt/pkg/dist/src/cli.js', { resolve: (p) => p, realpath: real }), true);
    assert.equal(isEntryPoint('/usr/bin/mpc2', '/opt/pkg/dist/src/cli.js', { resolve: (p) => p, realpath: real }), false);
  });

  it('a path that cannot be resolved is not the entry point', () => {
    const boom = () => {
      throw new Error('ENOENT');
    };
    assert.equal(isEntryPoint('/x/y', '/opt/pkg/dist/src/cli.js', { resolve: (p) => p, realpath: boom }), false);
  });

  it('the real functions: the file itself, and the file without its extension', () => {
    const file = new URL('../src/cli.js', import.meta.url);
    const p = decodeURIComponent(file.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    assert.equal(isEntryPoint(p, p), true);
    assert.equal(isEntryPoint(p.replace(/\.js$/, ''), p), true);
  });
});
