// Regressions for the outside review of 2026-10-02 that move the set of inputs that pass or stop (0.2.21, Erik's
// decision): raw HTML inside Markdown is held to the caller's nesting limit (MPC-1), and code blocks apply the same
// skipped-subtree rule as the rest of the content (MPC-2). Every case has a control that must keep its result.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractHtml } from '../src/html.js';
import { run, RunError, type SourceInput } from '../src/run.js';

const input = (body: string, file: string): SourceInput => ({ body, base: 'https://example.com/page', meta: { kind: 'file', file, bytes: Buffer.byteLength(body, 'utf8'), baseUrl: 'https://example.com/page' } });
const opts = { strict: false, mode: 'offline' as const };
const shallowHtml = input('<main><p>x</p></main>', 'page.html');
const nested = (n: number, text = 'deep') => `${'<div>'.repeat(n)}${text}${'</div>'.repeat(n)}`;

describe('MPC-1: raw HTML in Markdown and the nesting limit', () => {
  it('a raw HTML block nested past a small limit is a RunError, as the same nesting on the HTML side is', () => {
    const md = input(`x\n\n${nested(5)}\n`, 'page.md');
    assert.throws(() => run(shallowHtml, md, { ...opts, limits: { maxNestingDepth: 3 } }), (err: unknown) => err instanceof RunError && /HTML nesting depth \d+ exceeds the limit of 3 levels/.test(err.message));
    const deepHtml = input(`<main>${nested(5)}</main>`, 'page.html');
    assert.throws(() => run(deepHtml, input('x\n', 'page.md'), { ...opts, limits: { maxNestingDepth: 3 } }), (err: unknown) => err instanceof RunError && /exceeds the limit of 3 levels/.test(err.message));
  });

  it('a raw HTML block within the limit still parses and compares', () => {
    const md = input(`x\n\n${nested(2)}\n`, 'page.md');
    const html = input(`<main><p>x</p>${nested(2)}</main>`, 'page.html');
    const report = run(html, md, { ...opts, limits: { maxNestingDepth: 3 } });
    assert.equal(report.summary.exitCode, 0, JSON.stringify(report.findings));
    assert.ok(report.findings.some((f) => f.code === 'MARKDOWN_RAW_HTML_PARSED'));
  });

  it('the boundary is the same as on the HTML side: exactly the limit passes, one more fails with the same depth and limit', () => {
    const limits = { maxNestingDepth: 3 };
    const ok = run(shallowHtml, input(`x\n\n${nested(3)}\n`, 'page.md'), { ...opts, limits });
    assert.ok(ok.findings.some((f) => f.code === 'MARKDOWN_RAW_HTML_PARSED'));
    const message = (fn: () => unknown): string => {
      try { fn(); } catch (err) { if (err instanceof RunError) return err.message; throw err; }
      throw new Error('expected a RunError');
    };
    const md = message(() => run(shallowHtml, input(`x\n\n${nested(4)}\n`, 'page.md'), { ...opts, limits }));
    const html = message(() => run(input(nested(4), 'page.html'), input('x\n', 'page.md'), { ...opts, limits }));
    assert.match(md, /limit of 3 levels/);
    assert.equal(md, html);
  });

  it('a raw HTML block 1 100 levels deep is a RunError at the default limit, not a skipped warning', () => {
    const md = input(`x\n\n${nested(1100)}\n`, 'page.md');
    assert.throws(() => run(shallowHtml, md, opts), (err: unknown) => err instanceof RunError && /HTML nesting depth \d+ exceeds the limit of 1024 levels/.test(err.message));
  });
});

describe('MPC-2: skipped subtrees inside code blocks', () => {
  const fenced = '```\nrun\n```\n';
  const pass = (html: string, md = fenced) => run(input(`<main>${html}</main>`, 'page.html'), input(md, 'page.md'), opts).summary.result;

  it('a button, template, nav or role element inside a pre is left out like it is in a paragraph', () => {
    assert.equal(pass('<pre><code>run<button>Copy</button></code></pre>'), 'pass');
    assert.equal(pass('<pre><code>run<template>hidden copy</template></code></pre>'), 'pass');
    assert.equal(pass('<pre><code>run<nav>menu</nav></code></pre>'), 'pass');
    assert.equal(pass('<pre><code>run<span role="navigation">menu</span></code></pre>'), 'pass');
  });

  it('controls: the same element in a paragraph, a hidden span in a pre, and real extra code text still compare', () => {
    assert.equal(pass('<p>run<button>Copy</button></p>', 'run\n'), 'pass');
    assert.equal(pass('<pre><code>run<span hidden>gone</span></code></pre>'), 'pass');
    assert.equal(pass('<pre><code>run<span>more</span></code></pre>'), 'fail');
    assert.equal(pass('<pre><code>run</code></pre>'), 'pass');
  });

  it('a code block that contains only a skipped element yields no code block', () => {
    const blocks = extractHtml('<main><pre><code><button>Copy</button></code></pre></main>').blocks;
    assert.equal(blocks.length, 0);
  });
});
