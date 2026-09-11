// The library entry (core.ts) is what a Cloudflare Worker bundles, so no Node.js built-in module may be
// reachable from it. This file walks the compiled import graph from dist/src/core.js, pins the public
// surface, compares the pure IP literal parser with node:net isIP, and checks that the optional lower
// limits stop a run with an error while the defaults leave every result unchanged.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as core from '../src/core.js';
import { align, AlignmentLimitError, DEFAULT_LIMITS, MAX_ALIGNMENT_PAIRS, MAX_SIMILARITY_CANDIDATES } from '../src/align.js';
import { MAX_NESTING_DEPTH } from '../src/html.js';
import type { Block } from '../src/model.js';
import { ipVersion } from '../src/netguard.js';
import { run, RunError, type Report, type SourceInput } from '../src/run.js';
import { fixture, ROOT } from './helpers.js';

const BUILTINS = new Set(['assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'http', 'https', 'module', 'net', 'os', 'path', 'process', 'stream', 'tls', 'url', 'util', 'worker_threads', 'zlib']);

/** Module specifiers of the static imports, re-exports and literal dynamic imports in one source text. */
export function importsIn(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|[\n;])\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of src.matchAll(/(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

describe('library entry', () => {
  it('reaches no Node.js built-in module from dist/src/core.js', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const deps = new Set(Object.keys(pkg.dependencies));
    const seen = new Set<string>();
    const bare = new Set<string>();
    const bad: string[] = [];
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of importsIn(fs.readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
        else if (spec.startsWith('node:') || BUILTINS.has(packageName(spec))) bad.push(`${path.relative(ROOT, file)} imports ${spec}`);
        else bare.add(packageName(spec));
      }
    };
    walk(path.join(ROOT, 'dist', 'src', 'core.js'));
    assert.deepEqual(bad, []);
    for (const b of bare) assert.ok(deps.has(b), `${b} is imported by the core but is not a declared dependency`);
    for (const f of ['cli.js', 'fetch.js']) assert.equal(seen.has(path.join(ROOT, 'dist', 'src', f)), false, `${f} must not be reachable from core.js`);
    assert.ok(seen.size >= 9, `the walk visited only ${seen.size} files`);
  });

  it('the import scanner sees each import form (negative control for the walk above)', () => {
    const planted = "import fs from 'node:fs';\nimport { x } from \"./a.js\";\nexport { y } from './b.js';\nexport * from './c.js';\nimport './d.js';\nconst z = await import('node:net');\nimport {\n  q,\n} from 'htmlparser2';\n";
    assert.deepEqual(importsIn(planted).sort(), ['./a.js', './b.js', './c.js', './d.js', 'htmlparser2', 'node:fs', 'node:net'].sort());
    const compiled = fs.readFileSync(path.join(ROOT, 'dist', 'src', 'cli.js'), 'utf8');
    assert.ok(importsIn(compiled).includes('node:fs'), 'the scanner must see the CLI import node:fs');
  });

  it('package.json points main, types and exports at the built library entry', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { main: string; types: string; exports: Record<string, unknown>; bin: Record<string, string> };
    assert.equal(pkg.main, './dist/src/core.js');
    assert.equal(pkg.types, './dist/src/core.d.ts');
    assert.deepEqual(pkg.exports['.'], { types: './dist/src/core.d.ts', default: './dist/src/core.js' });
    assert.equal(pkg.bin['markdown-parity-check'], './dist/src/cli.js');
    for (const f of [pkg.main, pkg.types]) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} must exist after the build`);
  });

  it('exports exactly the documented runtime surface', () => {
    assert.deepEqual(Object.keys(core).sort(), [
      'AlignmentLimitError', 'BlockedAddressError', 'DEFAULT_LIMITS', 'LIMITATIONS', 'MAX_ALIGNMENT_PAIRS', 'MAX_NESTING_DEPTH', 'MAX_SIMILARITY_CANDIDATES', 'RunError',
      'TOOL_NAME', 'TOOL_VERSION', 'assertPublicHost', 'assertPublicResolved', 'checkAlignmentLimit', 'deliveryFindings', 'errorReport',
      'ipVersion', 'isPublicAddress', 'isPublicIPv4', 'isPublicIPv6', 'maskHref', 'maskUrl', 'redactReport', 'redactText', 'renderJson', 'renderText', 'run',
    ].sort());
  });
});

describe('ipVersion', () => {
  it('answers like node:net isIP on valid, invalid and edge-case literals', () => {
    const corpus = [
      '0.0.0.0', '1.2.3.4', '255.255.255.255', '256.1.1.1', '01.2.3.4', '1.2.3', '1.2.3.4.5', ' 1.2.3.4', '1.2.3.4 ', '1.2.3.-4',
      '::', '::1', '1::', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7::', '::2:3:4:5:6:7:8', '::0:0:0:0:0:0:0', '1::2::3',
      '12345::1', '00000::1', 'fe80::1%eth0', 'fe80::1%', 'fe80::1%a b', '::ffff:127.0.0.1', '::ffff:256.0.0.1', '::ffff:1.2.3',
      '64:ff9b::192.0.2.1', '1:2:3:4:5:6:1.2.3.4', '1:2:3:4:5:6:7:1.2.3.4', '[::1]', 'localhost', 'example.com', '', 'g::1', ':1', '1:', '1:::2',
      '2001:db8::', '2001:DB8::A', '0:0:0:0:0:0:0:0', '1.2.3.4::', '::1.2.3.4', '1::1.2.3.4', '::ffff:0:1.2.3.4', 'fc00::', 'fe80::', 'ff02::1',
    ];
    const diff = corpus.filter((s) => ipVersion(s) !== isIP(s)).map((s) => `${JSON.stringify(s)}: ipVersion ${ipVersion(s)}, isIP ${isIP(s)}`);
    assert.deepEqual(diff, []);
  });
});

function paragraph(text: string, blockIndex: number): Block {
  return { type: 'paragraph', text, loose: text.toLowerCase(), links: [], numbers: [], location: { line: blockIndex + 1, blockIndex } };
}

function fileInput(body: string, file: string): SourceInput {
  return { meta: { kind: 'file', file, bytes: Buffer.byteLength(body, 'utf8'), baseUrl: 'https://example.com/page' }, body, base: 'https://example.com/page' };
}

function withoutTime(r: Report): Omit<Report, 'generatedAt'> {
  const { generatedAt: _t, ...rest } = r;
  return rest;
}

describe('optional lower limits', () => {
  const same = fixture('same');
  const opts = { strict: false, mode: 'offline' as const, frontMatter: 'strip' as const };

  it('default to the CLI limits and leave the report unchanged', () => {
    assert.deepEqual({ ...DEFAULT_LIMITS }, { maxAlignmentPairs: MAX_ALIGNMENT_PAIRS, maxSimilarityCandidates: MAX_SIMILARITY_CANDIDATES, maxSimilarityWork: Number.POSITIVE_INFINITY });
    const plain = run(fileInput(same.html, 'page.html'), fileInput(same.md, 'page.md'), opts);
    assert.equal(plain.summary.result, 'pass');
    for (const limits of [{}, { ...DEFAULT_LIMITS }, { maxSimilarityWork: 1e12 }]) {
      const r = run(fileInput(same.html, 'page.html'), fileInput(same.md, 'page.md'), { ...opts, limits });
      assert.deepEqual(withoutTime(r), withoutTime(plain));
    }
  });

  it('stop the run with a RunError when the block pair limit is lower than the page needs', () => {
    assert.throws(
      () => run(fileInput(same.html, 'page.html'), fileInput(same.md, 'page.md'), { ...opts, limits: { maxAlignmentPairs: 4 } }),
      (err: unknown) => err instanceof RunError && /Comparison limit exceeded: \d+ HTML blocks by \d+ Markdown blocks is \d+ block pairs, above the limit of 4\./.test(err.message),
    );
  });

  it('bound the similarity search work and the candidate count', () => {
    const a = Array.from({ length: 60 }, (_, i) => paragraph(`alpha beta gamma delta epsilon zeta html ${i}`, i));
    const b = Array.from({ length: 60 }, (_, i) => paragraph(`alpha beta gamma delta epsilon zeta markdown ${i}`, i));
    assert.throws(() => align(a, b, { maxSimilarityWork: 1000 }), (err: unknown) => err instanceof AlignmentLimitError && /needs more than 1000 token comparisons/.test(err.message));
    assert.throws(() => align(a, b, { maxSimilarityCandidates: 100 }), (err: unknown) => err instanceof AlignmentLimitError && /more than 100 similar block pairs/.test(err.message));
    const ok = align(a, b, { maxSimilarityWork: 60 * 60 * 8, maxSimilarityCandidates: 3600 });
    assert.equal(ok.pairs.length, 60);
    assert.equal(ok.pairs.every((p) => p.kind === 'similar'), true);
  });

  it('refuse a limit that is not a positive number', () => {
    for (const bad of [0, -1, Number.NaN, '5' as unknown as number]) {
      assert.throws(() => align([], [], { maxAlignmentPairs: bad }), TypeError);
      assert.throws(() => run(fileInput(same.html, 'page.html'), fileInput(same.md, 'page.md'), { ...opts, limits: { maxNestingDepth: bad } }), TypeError);
    }
  });
});

describe('nesting depth limit', () => {
  const opts = { strict: false, mode: 'offline' as const };
  const md = fileInput('deep', 'page.md');

  it('is 1 024 levels by default and leaves a normal page unchanged when raised', () => {
    assert.equal(MAX_NESTING_DEPTH, 1024);
    const same = fixture('same');
    const a = run(fileInput(same.html, 'page.html'), fileInput(same.md, 'page.md'), { ...opts, frontMatter: 'strip' });
    const b = run(fileInput(same.html, 'page.html'), fileInput(same.md, 'page.md'), { ...opts, frontMatter: 'strip', limits: { maxNestingDepth: 1_000_000 } });
    assert.deepEqual(withoutTime(a), withoutTime(b));
  });

  it('turns deep HTML into a RunError before the stack runs out, at any depth', () => {
    for (const depth of [2000, 20_000]) {
      const html = fileInput(`<main>${'<div>'.repeat(depth)}<p>deep</p>${'</div>'.repeat(depth)}</main>`, 'page.html');
      assert.throws(() => run(html, md, opts), (err: unknown) => err instanceof RunError && /HTML nesting depth \d+ exceeds the limit of 1024 levels/.test(err.message));
    }
    const shallow = fileInput(`<main>${'<div>'.repeat(50)}<p>deep</p>${'</div>'.repeat(50)}</main>`, 'page.html');
    assert.equal(run(shallow, md, opts).summary.result, 'pass');
    assert.throws(() => run(shallow, md, { ...opts, limits: { maxNestingDepth: 10 } }), (err: unknown) => err instanceof RunError && /exceeds the limit of 10 levels/.test(err.message));
  });

  it('turns deep Markdown into a RunError, whether the limit or the parser stops it', () => {
    const html = fileInput('<main><p>x</p></main>', 'page.html');
    assert.throws(() => run(html, fileInput('>'.repeat(1500) + ' x', 'page.md'), opts), (err: unknown) => err instanceof RunError && /Markdown nesting depth \d+ exceeds the limit of 1024 levels/.test(err.message));
    assert.throws(() => run(html, fileInput('>'.repeat(8000) + ' x', 'page.md'), opts), (err: unknown) => err instanceof RunError && /Markdown/.test(err.message));
  });
});
