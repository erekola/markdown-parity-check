// Regressions for the audit retest of 2026-09-28 that move the set of pairs that pass (0.2.16, Erik's decision,
// see turva/tyot/astra-uusinta-2026-09-28/korjausohje.md): a hidden checkbox is ignored in task state (R3, decision
// 2), a userinfo wrapped in parentheses or broken by a raw space is masked (04 F02, 04 F04, M1), a text report
// strips control characters (M3), limits.maxSimilarityWork also bounds unresolved same-label link pairing (M2, 04
// F09), and a spanned table or a reversed list report an info finding instead of being compared (decision 6, M5,
// M6). Every case has a control that must stay clean.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { compare, pairLinks } from '../src/compare.js';
import { AlignmentLimitError } from '../src/align.js';
import { extractHtml } from '../src/html.js';
import { extractMarkdown } from '../src/markdown.js';
import type { Finding, Link } from '../src/model.js';
import { CLI } from './helpers.js';

const BASE = 'https://example.test/page';

function check(html: string, md: string, opts: { profile?: 'generic' | 'starlight' } = {}) {
  const h = extractHtml(html, { baseUrl: BASE, profile: opts.profile });
  const m = extractMarkdown(md, { baseUrl: BASE });
  const r = compare(h, m, { bothBases: true });
  return { h, m, ...r, codes: r.findings.map((f: Finding) => `${f.code}:${f.severity}`) };
}
const page = (main: string) => `<!doctype html><html><body><main>${main}</main></body></html>`;

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('R3/decision 2: a hidden checkbox is ignored in task state', () => {
  it('a hidden checked checkbox before the real one does not answer for it', () => {
    const r = check(page('<ul><li><input hidden checked type="checkbox"><input type="checkbox">Task</li></ul>'), '- [ ] Task\n');
    assert.deepEqual(r.codes, []);
  });
  it('the same markup against a checked Markdown item is still an error, not silently passed', () => {
    const r = check(page('<ul><li><input hidden checked type="checkbox"><input type="checkbox">Task</li></ul>'), '- [x] Task\n');
    assert.ok(r.codes.includes('LIST_TASK_CHANGED:error'), r.codes.join());
  });
  it('a checkbox wrapped in a hidden ancestor is skipped the same way', () => {
    const r = check(page('<ul><li><span hidden><input checked type="checkbox"></span><input type="checkbox">Task</li></ul>'), '- [ ] Task\n');
    assert.deepEqual(r.codes, []);
  });
  it('a visible checkbox alone still compares as before', () => {
    const r = check(page('<ul><li><input checked type="checkbox">Task</li></ul>'), '- [ ] Task\n');
    assert.ok(r.codes.includes('LIST_TASK_CHANGED:error'), r.codes.join());
  });
  it('the Starlight profile skips a whole hidden Expressive Code line, not only a hidden span inside one', () => {
    const html = page('<div class="expressive-code"><figure><pre data-language="sh"><code><div class="ec-line" hidden><div class="code"><span>secret line</span></div></div><div class="ec-line"><div class="code"><span>npm install</span></div></div></code></pre></figure></div>');
    assert.deepEqual(check(html, '```sh\nnpm install\n```\n', { profile: 'starlight' }).codes, []);
  });
});

describe('04 F02, 04 F04, M1: userinfo masking that a run boundary used to defeat', () => {
  it('a parenthesized user name right after "scheme://" is masked in a block excerpt', () => {
    const r = check(page('<p>Open https://(name):SECRET@example.test/page for the private report details today.</p>'), 'Open https://(name):SECRET@example.test/page for the private report details today.\n');
    const excerpts = [r.h.blocks[0]?.location, ...r.findings.map((f) => f.html?.excerpt).filter(Boolean)];
    for (const f of r.findings) {
      if (f.html?.excerpt) assert.doesNotMatch(f.html.excerpt, /SECRET/, JSON.stringify(f));
      if (f.markdown?.excerpt) assert.doesNotMatch(f.markdown.excerpt, /SECRET/, JSON.stringify(f));
    }
    void excerpts;
  });
  it('the GFM mailto link a parenthesized userinfo derives is masked too, not only the free text around it', () => {
    // The HTML side is plain text (no anchor), so GFM's own autolinking of the exposed password inside the
    // Markdown becomes a Markdown-only link; both its text and its target must come back as ***.
    const r = check(page('<p>Open https://(name):SECRET@example.test/page for details.</p>'), 'Open https://(name):SECRET@example.test/page for details.\n');
    const added = r.findings.find((f) => f.code === 'LINK_ADDED');
    assert.ok(added, r.codes.join());
    assert.doesNotMatch(added!.message, /SECRET/, added!.message);
    assert.equal(added!.after, '***');
  });
  it('a userinfo broken by a raw space in --base-url is masked in both the text and the JSON error', () => {
    const text = cli(['--html-file', 'nonexistent-html-file-marker', '--markdown-file', 'nonexistent-markdown-file-marker', '--base-url', 'ftp://u:SPACE SECRET@example.test/?token=TOKEN#FRAG']);
    assert.equal(text.code, 2);
    assert.doesNotMatch(text.err, /SPACE SECRET/);
    assert.doesNotMatch(text.err, /TOKEN/);
    const json = cli(['--html-file', 'nonexistent-html-file-marker', '--markdown-file', 'nonexistent-markdown-file-marker', '--base-url', 'ftp://u:SPACE SECRET@example.test/?token=TOKEN#FRAG', '--format', 'json']);
    assert.equal(json.code, 2);
    const report = JSON.parse(json.out) as { summary: { error?: string } };
    assert.doesNotMatch(report.summary.error ?? '', /SPACE SECRET/);
    assert.doesNotMatch(report.summary.error ?? '', /TOKEN/);
  });
  it('an ordinary parenthetical link next to a URL is unaffected by the new masking', () => {
    // Both sides carry an explicit link (not a bare autolink), so a passing comparison here shows the parens are
    // still ordinary delimiters and PAREN_USERINFO, which requires a "scheme://(...):...@ " shape, left them alone.
    const r = check(
      page('<p>See (<a href="https://example.test/guide">https://example.test/guide</a>) for the guide.</p>'),
      'See ([https://example.test/guide](https://example.test/guide)) for the guide.\n',
    );
    assert.deepEqual(r.codes, []);
  });
});

describe('M3: a text report strips terminal control characters', () => {
  it('an ESC byte in the compared page never reaches any finding field', () => {
    const html = page('<p>Start \x1b[2J hidden terminal control</p>');
    const md = 'Start visible text\n';
    const r = check(html, md);
    assert.ok(r.codes.length > 0, r.codes.join());
    for (const f of r.findings) {
      const fields = [f.message, f.before, f.after, f.html?.excerpt, f.markdown?.excerpt].filter((v): v is string => typeof v === 'string');
      for (const v of fields) assert.doesNotMatch(v, /\x1b/, JSON.stringify(f));
    }
  });
});

describe('M2, 04 F09: limits.maxSimilarityWork also bounds unresolved same-label link pairing', () => {
  const link = (n: number, text = 'download'): Link => ({ text, rawHref: `/target-${n}`, resolved: null });
  it('a tiny budget refuses instead of scanning the whole shared-label list', () => {
    const hLinks = Array.from({ length: 50 }, (_, i) => link(i + 1));
    const mLinks = Array.from({ length: 51 }, (_, i) => link(51 - i));
    assert.throws(() => pairLinks(hLinks, mLinks, 5), AlignmentLimitError);
  });
  it('a generous budget still pairs unresolved links by shared text and target as before', () => {
    const hLinks = [link(1), link(2)];
    const mLinks = [link(2), link(1)];
    const { pairs, missing, added } = pairLinks(hLinks, mLinks, 1000);
    assert.deepEqual(missing, []);
    assert.deepEqual(added, []);
    assert.equal(pairs.length, 2);
  });
  it('compare() threads the same limit through and refuses instead of taking seconds', () => {
    const n = 300;
    const htmlLinks = Array.from({ length: n }, (_, i) => `<a href="/target-${i + 1}">download</a>`).join(' ');
    const mdLinks = Array.from({ length: n + 1 }, (_, i) => `[download](/target-${n + 1 - i})`).join(' ');
    const h = extractHtml(page(`<p>${htmlLinks}</p>`), { baseUrl: null });
    const m = extractMarkdown(mdLinks, { baseUrl: null });
    assert.throws(() => compare(h, m, { limits: { maxSimilarityWork: 10 } }), AlignmentLimitError);
  });
});

describe('decision 6, M5: a rowspan or colspan table is an info finding, not a comparison', () => {
  it('a spanned table reports EXTRACTION_TABLE_SPAN_NOT_COMPARED and no cell findings, even when a value moved', () => {
    const html = page('<table><caption>Warning 99: <a href="/policy">restriction</a></caption><tr><th colspan="2">Plan</th></tr><tr><td rowspan="2">Basic</td><td>A</td></tr><tr><td>B</td></tr></table>');
    const md = 'Warning 99: [restriction](/policy)\n\n| Plan | |\n| --- | --- |\n| Basic | A |\n| B | |\n';
    const r = check(html, md);
    assert.ok(r.codes.includes('EXTRACTION_TABLE_SPAN_NOT_COMPARED:info'), r.codes.join());
    assert.ok(!r.codes.some((c) => c.startsWith('TABLE_')), r.codes.join());
    // The caption is unaffected: its link still compares.
    assert.ok(!r.codes.some((c) => c.startsWith('LINK_') || c.startsWith('BLOCK_')), r.codes.join());
  });
  it('an ordinary table without a span still compares cell by cell', () => {
    const html = page('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
    const md = '| A | B |\n| - | - |\n| 1 | 9 |\n';
    const r = check(html, md);
    assert.ok(r.codes.includes('TABLE_CELL_CHANGED:error'), r.codes.join());
  });
  it('colspan="1" is not a span', () => {
    const html = page('<table><tr><th colspan="1">A</th></tr><tr><td colspan="1">1</td></tr></table>');
    const md = '| A |\n| - |\n| 1 |\n';
    assert.deepEqual(check(html, md).codes, []);
  });
});

describe('decision 6, M6: a reversed list is an info finding, its numbering never compared', () => {
  it('a reversed list with start reports the info finding and never LIST_NUMBER_CHANGED', () => {
    const r = check(page('<ol reversed start="3"><li>Alpha</li><li>Beta</li><li>Gamma</li></ol>'), '3. Alpha\n4. Beta\n5. Gamma\n');
    assert.deepEqual(r.codes, ['EXTRACTION_LIST_REVERSED_NOT_COMPARED:info']);
  });
  it('a non-reversed list with start is unaffected and still compares numbers', () => {
    const r = check(page('<ol start="3"><li>Alpha</li></ol>'), '9. Alpha\n');
    assert.ok(r.codes.includes('LIST_NUMBER_CHANGED:error'), r.codes.join());
  });
});
