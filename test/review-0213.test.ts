// Regressions for the comparison findings of the outside review of 2026-09-26 that move the set of pairs that pass
// (0.2.13, Erik's decision): the main content choice and hidden content (F05), table captions (F06), footnotes (F07),
// same-text links with swapped targets (F08), link text that differs only in case (F11), zero width joiners (F12)
// and list numbering, nesting and task state (F13). Every case has a control that must stay clean.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare } from '../src/compare.js';
import { extractHtml } from '../src/html.js';
import { extractMarkdown } from '../src/markdown.js';
import type { Finding } from '../src/model.js';

const BASE = 'https://example.test/page';

function check(html: string, md: string, opts: { profile?: 'generic' | 'starlight' } = {}) {
  const h = extractHtml(html, { baseUrl: BASE, profile: opts.profile });
  const m = extractMarkdown(md, { baseUrl: BASE });
  const r = compare(h, m, { bothBases: true });
  return { h, m, ...r, codes: r.findings.map((f: Finding) => `${f.code}:${f.severity}`) };
}
const page = (main: string) => `<!doctype html><html><body><main>${main}</main></body></html>`;

describe('F05: the main content and hidden content', () => {
  it('a hidden <main> before the visible one is not compared in its place', () => {
    const r = check('<html><body><main hidden><p>Approved.</p></main><main><p>Visible critical restriction.</p></main></body></html>', 'Approved.\n');
    assert.ok(r.codes.includes('BLOCK_MISSING:error'), r.codes.join());
    assert.equal(r.h.blocks[0]?.text, 'Visible critical restriction.');
  });

  it('a <main> inside a hidden element is skipped, and the visible <article> is used', () => {
    const r = check('<html><body><div hidden><main><p>Approved.</p></main></div><article><p>Visible critical restriction.</p></article></body></html>', 'Approved.\n');
    assert.equal(r.h.strategy, 'article');
    assert.ok(r.codes.includes('BLOCK_MISSING:error'), r.codes.join());
  });

  it('two visible <main> elements side by side are a warning; an <article> inside <main> is not', () => {
    const two = check('<html><body><main><p>One.</p></main><main><p>Two.</p></main></body></html>', 'One.\n');
    assert.ok(two.codes.includes('EXTRACTION_MULTIPLE_ROOTS:warning'), two.codes.join());
    const nested = check(page('<article><h1>Title</h1><p>Body text.</p></article>'), '# Title\n\nBody text.\n');
    assert.deepEqual(nested.codes, []);
  });

  it('hidden list items, table rows, cells and code spans are skipped like hidden paragraphs', () => {
    assert.deepEqual(check(page('<ul><li>Visible item.</li><li hidden>Hidden item.</li></ul>'), '- Visible item.\n').codes, []);
    assert.deepEqual(check(page('<table><tr><th>A</th><th>B</th></tr><tr hidden><td>x</td><td>y</td></tr><tr><td>1</td><td>2</td></tr></table>'), '| A | B |\n| - | - |\n| 1 | 2 |\n').codes, []);
    assert.deepEqual(check(page('<table><tbody hidden><tr><td>x</td></tr></tbody><tbody><tr><td>1</td></tr></tbody></table>'), '| 1 |\n| - |\n').codes, []);
    assert.deepEqual(check(page('<pre><code>npm install<span hidden> --unsafe</span></code></pre>'), '    npm install\n').codes, []);
    assert.deepEqual(check(page('<pre><code>npm install<span aria-hidden="true"> --unsafe</span></code></pre>'), '    npm install\n').codes, []);
  });

  it('the Starlight profile skips a hidden span inside an Expressive Code line too', () => {
    const html = page('<div class="expressive-code"><figure><pre data-language="sh"><code><div class="ec-line"><div class="code"><span>npm install</span><span hidden> --unsafe</span></div></div></code></pre></figure></div>');
    assert.deepEqual(check(html, '```sh\nnpm install\n```\n', { profile: 'starlight' }).codes, []);
  });

  it('a hidden inline element in the Markdown hides its text; without a closing tag it is a warning', () => {
    const hidden = check(page('<p>Allowed restriction.</p>'), 'Allowed <span hidden>restriction</span>.\n');
    assert.ok(hidden.codes.includes('TEXT_CHANGED:error'), hidden.codes.join());
    const visible = check(page('<p>Allowed restriction.</p>'), 'Allowed <span class="x">restriction</span>.\n');
    assert.deepEqual(visible.codes, []);
    const nested = check(page('<p>Allowed.</p>'), 'Allowed<span hidden> <span>inner</span> tail</span>.\n');
    assert.deepEqual(nested.codes, []);
    const open = check(page('<p>Allowed restriction.</p>'), 'Allowed <span hidden>restriction.\n');
    assert.ok(open.codes.includes('MARKDOWN_INLINE_HTML_UNSUPPORTED:warning'), open.codes.join());
  });
});

describe('F06: a table caption is content', () => {
  const table = '<tr><th>Item</th><th>Standard</th></tr>';
  it('a caption missing from the Markdown is reported, with its number and link', () => {
    const r = check(page(`<table><caption>Warning: at most 5 doses, see <a href="/warning">details</a>.</caption>${table}</table>`), '| Item | Standard |\n| - | - |\n');
    assert.ok(r.codes.includes('BLOCK_MISSING:error'), r.codes.join());
    assert.equal(r.h.blocks[0]?.text, 'Warning: at most 5 doses, see details.');
    assert.deepEqual(r.h.blocks[0]?.numbers, ['5']);
  });
  it('a caption written as a paragraph before the Markdown table passes', () => {
    const r = check(page(`<table><caption>Warning: at most 5 doses.</caption>${table}</table>`), 'Warning: at most 5 doses.\n\n| Item | Standard |\n| - | - |\n');
    assert.deepEqual(r.codes, []);
  });
});

describe('F07: footnotes are reported, not dropped', () => {
  it('a footnote added to the Markdown is a warning with its text', () => {
    const r = check(page('<p>Use daily.</p>'), 'Use daily.[^r]\n\n[^r]: Do not exceed 5 doses. [Warning details](/warning).\n');
    const f = r.findings.find((x) => x.code === 'MARKDOWN_FOOTNOTE_NOT_COMPARED');
    assert.equal(f?.severity, 'warning');
    assert.match(f?.markdown?.excerpt ?? '', /Do not exceed 5 doses/);
  });
  it('a Markdown without footnotes is unaffected', () => {
    assert.deepEqual(check(page('<p>Use daily.</p>'), 'Use daily.\n').codes, []);
  });
});

describe('F08: same-text links with swapped targets', () => {
  const html = page('<p>Linux: <a href="/linux">download</a>; Windows: <a href="/windows">download</a>.</p>');
  it('are two changed targets', () => {
    const r = check(html, 'Linux: [download](/windows); Windows: [download](/linux).\n');
    assert.deepEqual(r.codes, ['LINK_TARGET_CHANGED:error', 'LINK_TARGET_CHANGED:error']);
  });
  it('the same links in the same order pass, and an extra link with the same text is one added link', () => {
    assert.deepEqual(check(html, 'Linux: [download](/linux); Windows: [download](/windows).\n').codes, []);
    const extra = check(html, 'Linux: [download](/linux); Windows: [download](/windows). Mac: [download](/mac)\n');
    assert.deepEqual(extra.codes.filter((c) => c.startsWith('LINK_')), ['LINK_ADDED:error']);
  });
});

describe('F11: link text that differs only in case', () => {
  it('is one minor text change, not a missing and an added link, and passes in the default mode', () => {
    const r = check(page('<p>Read <a href="/help">Help</a>.</p>'), 'Read [help](/help).\n');
    assert.deepEqual(r.codes, ['TEXT_MINOR_CHANGED:warning']);
  });
  it('a case change with a different target is a changed target', () => {
    const r = check(page('<p>Read <a href="/help">Help</a>.</p>'), 'Read [help](/other).\n');
    assert.deepEqual(r.codes.filter((c) => c.startsWith('LINK_')), ['LINK_TARGET_CHANGED:error']);
  });
});

describe('F12: zero width joiners', () => {
  const zwj = String.fromCharCode(0x200d);
  const woman = String.fromCodePoint(0x1f469);
  const laptop = String.fromCodePoint(0x1f4bb);
  it('an emoji sequence without its joiner is a minor change, not equal', () => {
    const r = check(page(`<p>Our role: ${woman}${zwj}${laptop}.</p>`), `Our role: ${woman}${laptop}.\n`);
    assert.deepEqual(r.codes, ['TEXT_MINOR_CHANGED:warning']);
  });
  it('the same sequence on both sides passes, and a zero width space still does not count', () => {
    assert.deepEqual(check(page(`<p>Our role: ${woman}${zwj}${laptop}.</p>`), `Our role: ${woman}${zwj}${laptop}.\n`).codes, []);
    assert.deepEqual(check(page(`<p>Hello${String.fromCharCode(0x200b)} world.</p>`), 'Hello world.\n').codes, []);
  });
});

describe('the independent review before 0.2.13: time on long lists and unclosed hidden tags', () => {
  // Growth, not a wall clock: a fixed limit failed on the slower CI runners although the code was linear. Four times
  // the input takes about four times as long when the work is linear and sixteen times when it is quadratic, as the
  // first 0.2.13 version was (a list of 20 000 items took ten seconds, 20 000 unclosed hidden tags two minutes).
  const time = (f: () => void) => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  const list = (n: number) => () => {
    const h = extractHtml(page(`<ol>${Array.from({ length: n }, (_, i) => `<li>Item ${i}</li>`).join('')}</ol>`), { baseUrl: BASE });
    assert.equal(h.blocks[n - 1]?.list?.ordinal, n);
  };
  const hidden = (n: number) => () => {
    const m = extractMarkdown(`Text ${'<span hidden>x '.repeat(n)}end.\n`, { baseUrl: BASE });
    assert.ok(m.issues.length > 0);
  };
  it('a numbered list grows about linearly from 5 000 to 20 000 items', () => {
    list(1000)();
    const small = time(list(5000));
    const large = time(list(20000));
    assert.ok(large < 8 * small, `5 000 items ${small.toFixed(0)} ms, 20 000 items ${large.toFixed(0)} ms`);
  });
  it('unclosed hidden tags grow about linearly from 5 000 to 20 000', () => {
    hidden(1000)();
    const small = time(hidden(5000));
    const large = time(hidden(20000));
    // The Markdown side measured 5 to 7 times on this input, so the bound sits between that and sixteen.
    assert.ok(large < 11 * small, `5 000 tags ${small.toFixed(0)} ms, 20 000 tags ${large.toFixed(0)} ms`);
  });
});

describe('F13: list numbering, nesting and task state', () => {
  it('a changed start number is an error, a changed list kind a warning', () => {
    assert.deepEqual(check(page('<ol start="7"><li>Seven.</li></ol>'), '1. Seven.\n').codes, ['LIST_NUMBER_CHANGED:error']);
    assert.deepEqual(check(page('<ol><li>First.</li></ol>'), '- First.\n').codes, ['LIST_KIND_CHANGED:warning']);
  });
  it('a nested item flattened in the Markdown is a nesting warning', () => {
    const r = check(page('<ul><li>Parent<ul><li>Child.</li></ul></li></ul>'), '- Parent\n- Child.\n');
    assert.deepEqual(r.codes, ['LIST_NESTING_CHANGED:warning']);
  });
  it('a changed task state is an error, a checkbox on one side only a warning', () => {
    assert.deepEqual(check(page('<ul><li><input type="checkbox" disabled checked> Done.</li></ul>'), '- [ ] Done.\n').codes, ['LIST_TASK_CHANGED:error']);
    assert.deepEqual(check(page('<ul><li>Done.</li></ul>'), '- [x] Done.\n').codes, ['LIST_TASK_CHANGED:warning']);
  });
  it('the HTML a GFM renderer writes for the same Markdown passes: start numbers, value, reversed lists, tasks and nesting', () => {
    const md = '7. Seven\n8. Eight\n   - Nested\n\n- [x] Done\n- [ ] Open\n';
    const html = page('<ol start="7"><li>Seven</li><li>Eight<ul><li>Nested</li></ul></li></ol><ul><li><input type="checkbox" disabled checked> Done</li><li><input type="checkbox" disabled> Open</li></ul>');
    assert.deepEqual(check(html, md).codes, []);
    assert.deepEqual(check(page('<ol><li value="3">Three</li><li>Four</li></ol>'), '3. Three\n4. Four\n').codes, []);
    // A reversed list counts down; Markdown has no reversed list and numbers on from its first item, so only the
    // first number is compared, and a faithful copy written with the visible numbers passes.
    assert.deepEqual(check(page('<ol reversed><li>Two</li><li>One</li></ol>'), '2. Two\n1. One\n').codes, []);
    assert.deepEqual(check(page('<ol reversed><li value="10">Ten</li><li>Nine</li><li>Eight</li></ol>'), '10. Ten\n9. Nine\n8. Eight\n').codes, []);
    assert.deepEqual(check(page('<ol reversed start="3"><li>Three</li><li>Two</li></ol>'), '5. Three\n4. Two\n').codes, ['LIST_NUMBER_CHANGED:error']);
    assert.deepEqual(check(page('<ol><li>One</li><li hidden>Hidden</li><li>Two</li></ol>'), '1. One\n2. Two\n').codes, []);
  });
});
