import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare } from '../src/compare.js';
import { extractHtml, HtmlExtractError } from '../src/html.js';
import { extractMarkdown } from '../src/markdown.js';
import type { Finding } from '../src/model.js';
import { fixture } from './helpers.js';

const BASE = 'https://example.com/page';

function runFixture(name: string, opts: { base?: string | null; selector?: string; frontMatter?: 'keep' | 'strip' } = {}) {
  const f = fixture(name);
  const base = opts.base === undefined ? BASE : opts.base;
  const h = extractHtml(f.html, { baseUrl: base, selector: opts.selector });
  const m = extractMarkdown(f.md, { baseUrl: base, frontMatter: opts.frontMatter });
  const r = compare(h, m, { bothBases: base !== null });
  return { h, m, ...r };
}

const codes = (fs: Finding[]) => fs.map((f) => f.code);
const errors = (fs: Finding[]) => fs.filter((f) => f.severity === 'error');

describe('same content, different formatting', () => {
  it('produces no findings at all', () => {
    const r = runFixture('same', { frontMatter: 'strip' });
    // The only finding is the informational front matter note: no error, no warning.
    assert.deepEqual(codes(r.findings), ['MARKDOWN_FRONT_MATTER_STRIPPED']);
    assert.equal(r.findings[0]?.severity, 'info');
    assert.equal(r.findings[0]?.markdown?.line, 1);
    assert.equal(r.coverage.htmlRatio, 1);
    assert.equal(r.coverage.markdownRatio, 1);
    assert.deepEqual(r.m.notes, ['Front matter (3 lines) was stripped as requested (--front-matter strip).']);
    // Default keep: the front matter is compared as written and flagged as a warning, never removed.
    const keep = runFixture('same');
    assert.equal(keep.findings.some((f) => f.code === 'MARKDOWN_POSSIBLE_FRONT_MATTER' && f.severity === 'warning'), true);
    assert.equal(keep.findings.some((f) => f.code === 'BLOCK_ADDED'), true);
  });
  it('maps HTML entities and nbsp to the Markdown characters', () => {
    const r = runFixture('same', { frontMatter: 'strip' });
    assert.equal(r.h.blocks[0]?.text, 'Agent readiness audit');
    assert.equal(r.h.blocks[1]?.text.includes('line & report'), true);
    assert.equal(r.h.blocks[1]?.text.includes('490 €'), true);
  });
});

describe('page chrome', () => {
  it('ignores nav, banner, complementary, top-level header/footer and scripts, but keeps article header/footer', () => {
    const r = runFixture('chrome');
    assert.deepEqual(errors(r.findings), []);
    assert.deepEqual(r.h.blocks.map((b) => b.text), ['Published 2026-09-10 by Erik', 'Only the article counts', 'Body text stays.', 'Tags: agents, markdown']);
    assert.equal(r.h.strategy, 'article');
  });
});

describe('missing and added blocks', () => {
  it('reports direction and source location', () => {
    const r = runFixture('missing-added');
    assert.deepEqual(codes(r.findings), ['BLOCK_MISSING', 'BLOCK_ADDED']);
    const missing = r.findings[0]!;
    assert.equal(missing.direction, 'html_only');
    assert.equal(missing.html?.line, 5);
    assert.equal(missing.html?.path, 'main > p:nth-of-type(2)');
    assert.equal(missing.markdown, undefined);
    const added = r.findings[1]!;
    assert.equal(added.direction, 'markdown_only');
    assert.equal(added.markdown?.line, 7);
    assert.equal(added.html, undefined);
    assert.equal(r.coverage.htmlMatched, 3);
    assert.equal(r.coverage.markdownMatched, 3);
  });
});

describe('numbers in aligned blocks', () => {
  it('reports price, percentage, date and version changes in block context, not as a page-wide set', () => {
    const r = runFixture('numbers');
    const nums = r.findings.filter((f) => f.code === 'NUMBER_CHANGED');
    assert.equal(nums.length, 3);
    assert.deepEqual(nums.map((f) => [f.before, f.after]), [
      ['490€', '590€'],
      ['87%', '78%'],
      ['2026-09-10, 1.4.2', '2026-09-01, 1.4.3'],
    ]);
    assert.equal(nums[0]?.html?.line, 4);
    assert.equal(nums[0]?.markdown?.line, 3);
    assert.deepEqual(errors(r.findings).length, 3);
    // The unchanged "42" sentence does not appear.
    assert.equal(r.findings.some((f) => f.html?.excerpt?.includes('42')), false);
  });
});

describe('links', () => {
  it('reports changed targets, fragments, and links missing on one side; resolves relative links against the base', () => {
    const r = runFixture('links');
    const byCode = (c: string) => r.findings.filter((f) => f.code === c);
    const changed = byCode('LINK_TARGET_CHANGED');
    assert.equal(changed.length, 2);
    assert.equal(changed[0]?.before, 'https://example.com/guides/llms-txt');
    assert.equal(changed[0]?.after, 'https://example.com/guides/llms-txt-validator');
    // Fragments are detected but never shown: the report names the differing part instead.
    assert.equal(changed[1]?.before, 'https://example.com/pricing');
    assert.equal(changed[1]?.after, 'https://example.com/pricing');
    assert.match(changed[1]?.message ?? '', /fragment differs/);
    assert.equal(byCode('LINK_MISSING').length, 1);
    assert.equal(byCode('LINK_MISSING')[0]?.before, '/lost');
    // The relative ../docs/spec resolves to the same absolute target: no finding.
    assert.equal(r.findings.some((f) => f.html?.excerpt?.includes('relative')), false);
    assert.equal(byCode('LINK_UNVERIFIED').length, 0);
  });
  it('does not claim relative and absolute forms equal without a base', () => {
    const r = runFixture('links', { base: null });
    const unverified = r.findings.filter((f) => f.code === 'LINK_UNVERIFIED');
    assert.equal(unverified.length, 1);
    assert.equal(unverified[0]?.severity, 'warning');
    assert.equal(unverified[0]?.before, '../docs/spec');
  });
  it('classifies two relative forms without a base by what any base could make of them', () => {
    const run = (h: string, m: string) => compare(extractHtml(`<main><p><a href="${h}">l</a></p></main>`), extractMarkdown(`[l](${m})\n`));
    // The same address under every base: no finding.
    for (const [h, m] of [['./guide', 'guide'], ['a/../guide', 'guide'], ['guide/./x', 'guide/x']] as const) {
      assert.deepEqual(run(h, m).findings, [], `${h} vs ${m}`);
    }
    // Different under every base: still an error, with the differing part named.
    for (const [h, m, part] of [['guide', 'other', 'path or host'], ['/x', '/y', 'path or host'], ['guide?a=1', 'guide?a=2', 'query'], ['guide#one', 'guide#two', 'fragment']] as const) {
      const r = run(h, m);
      assert.deepEqual(codes(r.findings), ['LINK_TARGET_CHANGED'], `${h} vs ${m}`);
      assert.equal(r.findings[0]?.severity, 'error');
      assert.ok((r.findings[0]?.message ?? '').includes(`(${part} differs)`), r.findings[0]?.message);
    }
    // Equal under some bases and not others: a warning, never an error or silence.
    // ../d//.. climbs above its start and descends into a segment named d, so it reuses the base's own
    // segment names: a check that tries one set of names can see it equal to . when it is not.
    for (const [h, m] of [['../guide', 'guide'], ['/docs/guide', 'guide'], ['?q=1', './?q=1'], ['//base.invalid/x', '/x'], ['../d//..', '.'], ['./?q', '../d//..?q'], ['%2e%2e/d//%2e%2e', '.'], ['../e/..', '.']] as const) {
      const r = run(h, m);
      assert.deepEqual(codes(r.findings), ['LINK_UNVERIFIED'], `${h} vs ${m}`);
      assert.equal(r.findings[0]?.severity, 'warning');
    }
  });
});

describe('duplicates and order', () => {
  it('reports one missing occurrence of a repeated block, at the right position', () => {
    const r = runFixture('duplicate');
    assert.deepEqual(codes(r.findings), ['BLOCK_MISSING']);
    assert.equal(r.findings[0]?.html?.path, 'main > p:nth-of-type(3)');
    assert.equal(r.findings[0]?.html?.excerpt, 'Book a slot.');
  });
  it('reports reordering as warnings only', () => {
    const r = runFixture('reorder');
    assert.deepEqual(errors(r.findings), []);
    assert.equal(r.findings.every((f) => f.code === 'ORDER_CHANGED'), true);
    assert.equal(r.findings.length > 0, true);
    assert.equal(r.coverage.htmlRatio, 1);
  });
});

describe('tables, lists, code and Unicode', () => {
  it('reports the single changed cell with row and column, keeps list nesting, keeps code whitespace', () => {
    const r = runFixture('table-list-code');
    const cell = r.findings.filter((f) => f.code === 'TABLE_CELL_CHANGED');
    assert.equal(cell.length, 1);
    assert.equal(cell[0]?.message, 'Table cell (row 3, column 3) differs.');
    assert.deepEqual([cell[0]?.before, cell[0]?.after], ['25 €', '35 €']);
    assert.deepEqual(r.h.blocks.filter((b) => b.type === 'listItem').map((b) => b.text), ['First step', 'Second step', 'Nested detail', 'Third step']);
    assert.deepEqual(r.m.blocks.filter((b) => b.type === 'listItem').map((b) => b.text), ['First step', 'Second step', 'Nested detail', 'Third step']);
    assert.deepEqual(codes(r.findings.filter((f) => f.code.startsWith('CODE') || f.code === 'TEXT_CHANGED')), ['CODE_WHITESPACE_CHANGED', 'TEXT_CHANGED']);
    const ws = r.findings.find((f) => f.code === 'CODE_WHITESPACE_CHANGED')!;
    assert.equal(ws.severity, 'warning');
    const num = r.findings.find((f) => f.code === 'NUMBER_CHANGED');
    assert.equal(num, undefined, 'code blocks are compared as code, not as numbers');
    // The Unicode paragraph matches exactly.
    const uni = r.h.blocks.find((b) => b.text.startsWith('Café'))!;
    assert.equal(uni.text, 'Café naïve — “quoted” <tag> & Ω ≥ 3');
    assert.equal(r.findings.some((f) => f.html?.blockIndex === uni.location.blockIndex), false);
  });
});

describe('regressions from the 2026-09-10 review', () => {
  it('1. link query values and fragments never reach a finding, and a query-only change is still detected', () => {
    const r = compare(
      extractHtml('<main><p>See <a href="/docs?token=SYNTHETIC-SECRET-1#private">docs</a>.</p><p>Go <a href="/x?sig=SYNTHETIC-SECRET-2">there</a>.</p></main>', { baseUrl: 'https://example.com/' }),
      extractMarkdown('See [docs](/other?token=SYNTHETIC-SECRET-3).\n\nGo [there](/x?sig=SYNTHETIC-SECRET-4).\n', { baseUrl: 'https://example.com/' }),
      { bothBases: true },
    );
    const text = JSON.stringify(r.findings);
    assert.doesNotMatch(text, /SYNTHETIC-SECRET/);
    assert.deepEqual(codes(r.findings), ['LINK_TARGET_CHANGED', 'LINK_TARGET_CHANGED']);
    assert.match(r.findings[0]?.message ?? '', /path or host, query, fragment differs/);
    assert.match(r.findings[1]?.message ?? '', /\(query differs\)/);
    assert.equal(r.findings[1]?.before, 'https://example.com/x?sig=***');
    assert.equal(r.findings[1]?.after, 'https://example.com/x?sig=***');
    // Missing and added links are masked too, absolute and relative.
    const r2 = compare(extractHtml('<main><p>A <a href="/m?k=SYNTHETIC-SECRET-5#f">link</a>.</p></main>'), extractMarkdown('A link.\n'));
    assert.deepEqual(codes(r2.findings), ['LINK_MISSING']);
    assert.doesNotMatch(JSON.stringify(r2.findings), /SYNTHETIC-SECRET|#f/);
    assert.equal(r2.findings[0]?.before, '/m?k=***');
  });
  it('2. a sign change is a numeric change, in both directions, also with units', () => {
    for (const [h, m] of [
      ['Temperature -5 C.', 'Temperature 5 C.'],
      ['Temperature 5 C.', 'Temperature -5 C.'],
      ['Change of -3 % this year.', 'Change of +3 % this year.'],
      ['Balance −120 €.', 'Balance 120 €.'],
    ] as const) {
      const r = compare(extractHtml(`<main><p>${h}</p></main>`), extractMarkdown(`${m}\n`));
      assert.deepEqual(codes(r.findings), ['NUMBER_CHANGED'], `${h} vs ${m}`);
      assert.equal(r.findings[0]?.severity, 'error');
    }
    // Ranges written with an en dash and a hyphen are the same numbers; hyphen-only tokens are not values.
    const range = compare(extractHtml('<main><p>Delivery in 3\u20137 business days, pages 3\u201410, tel. 040-123 4567.</p></main>'), extractMarkdown('Delivery in 3-7 business days, pages 3-10, tel. 040-123 4567.\n'));
    assert.equal(range.findings.some((f) => f.code === 'NUMBER_CHANGED'), false, JSON.stringify(range.findings));
    // Unicode minus and ASCII hyphen are the same sign; date separators are not signs.
    const same = compare(extractHtml('<main><p>Balance −5 € on 2026-09-10.</p></main>'), extractMarkdown('Balance -5 € on 2026-09-10.\n'));
    assert.equal(same.findings.some((f) => f.code === 'NUMBER_CHANGED'), false);
  });
  it('3. reference-style Markdown links resolve to their definitions', () => {
    const md = 'Read [docs][d] and [spec] and [collapsed][].\n\n[d]: /docs\n[spec]: /spec "Spec"\n[collapsed]: /c\n';
    const equal = compare(extractHtml('<main><p>Read <a href="/docs">docs</a> and <a href="/spec">spec</a> and <a href="/c">collapsed</a>.</p></main>'), extractMarkdown(md));
    assert.deepEqual(equal.findings, []);
    const added = compare(extractHtml('<main><p>Read docs and spec and collapsed.</p></main>'), extractMarkdown(md));
    assert.deepEqual(codes(added.findings), ['LINK_ADDED', 'LINK_ADDED', 'LINK_ADDED']);
    const changed = compare(extractHtml('<main><p>Read <a href="/old">docs</a>.</p></main>'), extractMarkdown('Read [docs][d].\n\n[d]: /docs\n'));
    assert.deepEqual(codes(changed.findings), ['LINK_TARGET_CHANGED']);
    // An unresolved reference is literal text, and the first definition wins.
    const literal = extractMarkdown('See [nothing][x].\n\n[d]: /first\n[d]: /second\n\n[y][d]\n');
    assert.equal(literal.blocks[0]?.text, 'See [nothing][x].');
    assert.equal(literal.blocks[1]?.links[0]?.rawHref, '/first');
  });
  it('5. a raw HTML block in Markdown is parsed and compared, and the report says so', () => {
    const r = compare(extractHtml('<main><p>Visible.</p></main>'), extractMarkdown('Visible.\n\n<div>Additional important condition.</div>\n'));
    assert.deepEqual(codes(r.findings), ['BLOCK_ADDED', 'MARKDOWN_RAW_HTML_PARSED']);
    assert.equal(r.findings[0]?.markdown?.line, 3);
    const ok = compare(extractHtml('<main><p>Visible.</p><p>Extra.</p></main>'), extractMarkdown('Visible.\n\n<p>Extra.</p>\n'));
    assert.deepEqual(codes(ok.findings), ['MARKDOWN_RAW_HTML_PARSED']);
    assert.equal(ok.findings[0]?.severity, 'info');
    const comment = compare(extractHtml('<main><p>Visible.</p></main>'), extractMarkdown('Visible.\n\n<!-- note -->\n'));
    assert.deepEqual(comment.findings, []);
    // Script content is machinery, not skipped text; sub-block lines map to their own source lines.
    const script = compare(extractHtml('<main><p>Visible.</p></main>'), extractMarkdown("Visible.\n\n<script>alert('x')</script>\n"));
    assert.deepEqual(script.findings, []);
    const nested = extractMarkdown('Intro.\n\n<div>\n<p>First</p>\n<p>Second</p>\n</div>\n');
    assert.deepEqual(nested.blocks.map((b) => [b.text, b.location.line]), [['Intro.', 1], ['First', 4], ['Second', 5]]);
    // CodeQL js/incomplete-multi-character-sanitization (2026-09-10): the visible-text check reads the
    // parsed DOM instead of stripping comments with a regex, so nested or broken comment markers are read
    // the way a browser reads them. A script inside a comment is never text, and the text left over
    // after a broken comment is compared as the text a reader sees.
    const commented = compare(extractHtml('<main><p>Visible.</p></main>'), extractMarkdown('Visible.\n\n<!-- <p>Not shown</p> --><!--<script>alert(1)</script>-->\n'));
    assert.deepEqual(commented.findings, []);
    const broken = compare(extractHtml('<main><p>Visible.</p></main>'), extractMarkdown('Visible.\n\n<!-<!-- x -->- leftover --><!--<script>alert(1)</script>-->\n'));
    assert.deepEqual(codes(broken.findings), ['BLOCK_ADDED']);
    const excerptText = broken.findings[0]?.markdown?.excerpt ?? '';
    assert.equal(excerptText.includes('script'), false);
    assert.equal(excerptText.includes('leftover'), true);
  });
  it('6. front matter is never removed by default; strip is explicit and always reported', () => {
    const prose = compare(extractHtml('<main><p>Keep.</p></main>'), extractMarkdown('---\nImportant missing condition.\n---\nKeep.\n'));
    assert.equal(prose.findings.some((f) => f.code === 'BLOCK_ADDED' && f.markdown?.excerpt === 'Important missing condition.'), true);
    assert.equal(prose.findings.some((f) => f.code.startsWith('MARKDOWN_FRONT_MATTER') || f.code === 'MARKDOWN_POSSIBLE_FRONT_MATTER'), false);
    // Lists, headings, indented code and key: value prose between fences stay content by default.
    for (const inner of ['- Important restriction', '# Important restriction', '    code line', 'Note: important restriction']) {
      const r = compare(extractHtml('<main><p>Keep.</p></main>'), extractMarkdown(`---\n\n${inner}\n\n---\n\nKeep.\n`));
      assert.equal(r.findings.some((f) => f.severity === 'error'), true, inner);
      const warn = r.findings.find((f) => f.code === 'MARKDOWN_POSSIBLE_FRONT_MATTER');
      // A YAML-looking block is warned about (strict fails); a plainly non-YAML block is not.
      if (inner.startsWith('-') || inner.startsWith('#') || inner.startsWith('Note:') || inner.startsWith('    ')) assert.equal(warn?.severity, 'warning', inner);
    }
    const src = '---\ntitle: T\ntags:\n  - a\n  - b\n# c\n---\n\nBody.\n';
    const kept = extractMarkdown(src);
    assert.deepEqual(kept.issues.map((i) => [i.code, i.severity, i.line]), [['MARKDOWN_POSSIBLE_FRONT_MATTER', 'warning', 1]]);
    assert.equal(kept.blocks.some((b) => b.text === 'Body.'), true);
    assert.equal(kept.blocks.some((b) => b.text.includes('title: T')), true, 'kept as content');
    const stripped = extractMarkdown(src, { frontMatter: 'strip' });
    assert.deepEqual(stripped.blocks.map((b) => [b.text, b.location.line]), [['Body.', 9]]);
    assert.deepEqual(stripped.issues.map((i) => [i.code, i.severity, i.line]), [['MARKDOWN_FRONT_MATTER_STRIPPED', 'info', 1]]);
    assert.equal(extractMarkdown('Body.\n\n---\ntitle: T\n---\n').issues.length, 0);
    assert.match(extractMarkdown('Body.\n', { frontMatter: 'strip' }).notes[0] ?? '', /nothing was stripped/);
  });
});

describe('regressions from the 2026-09-10 review, round 2', () => {
  it('R2-1. a URL that is visible text is masked in excerpts, before/after and messages, also when truncated', () => {
    const url = 'https://example.com/docs?token=SYNTHETIC-R2-SECRET#private';
    const long = 'x'.repeat(60) + ' ' + url;
    const r = compare(
      extractHtml(`<main><p>See <a href="${url}">${url}</a></p><p>${long}</p><p>Bare ${url} in text.</p></main>`, { baseUrl: 'https://example.com/' }),
      extractMarkdown(`Other content.\n\nBare <${url}> in text.\n`, { baseUrl: 'https://example.com/' }),
      { bothBases: true },
    );
    const serialized = JSON.stringify(r.findings);
    assert.doesNotMatch(serialized, /SYNTHETIC|#private/);
    assert.match(serialized, /token=\*\*\*/);
    assert.equal(r.findings.some((f) => f.code === 'BLOCK_MISSING'), true);
    // The truncated excerpt was masked before the cut.
    const cut = r.findings.find((f) => f.html?.excerpt?.startsWith('xxxx'));
    assert.ok(cut);
    assert.doesNotMatch(cut.html?.excerpt ?? '', /SYNTHETIC/);
    // Query-only and fragment-only differences are still detected.
    const q = compare(extractHtml('<main><p><a href="/x?k=SYNTHETIC-A">l</a></p></main>', { baseUrl: 'https://e.com/' }), extractMarkdown('[l](/x?k=SYNTHETIC-B)\n', { baseUrl: 'https://e.com/' }), { bothBases: true });
    assert.deepEqual(codes(q.findings), ['LINK_TARGET_CHANGED']);
    assert.match(q.findings[0]?.message ?? '', /\(query differs\)/);
    const f = compare(extractHtml('<main><p><a href="/x#one">l</a></p></main>', { baseUrl: 'https://e.com/' }), extractMarkdown('[l](/x#two)\n', { baseUrl: 'https://e.com/' }), { bothBases: true });
    assert.match(f.findings[0]?.message ?? '', /\(fragment differs\)/);
    assert.doesNotMatch(JSON.stringify(f.findings), /#one|#two/);
  });
  it('R2-3. inline HTML anchors in Markdown are links: same, added, missing, changed', () => {
    const same = compare(extractHtml('<main><p>Read <a href="/docs">the <em>docs</em></a> now.</p></main>', { baseUrl: 'https://e.com/' }), extractMarkdown('Read <a href="/docs">the *docs*</a> now.\n', { baseUrl: 'https://e.com/' }), { bothBases: true });
    assert.deepEqual(same.findings, []);
    const abs = compare(extractHtml('<main><p><a href="https://e.com/docs">docs</a></p></main>', { baseUrl: 'https://e.com/' }), extractMarkdown('<a href="/docs">docs</a>\n', { baseUrl: 'https://e.com/' }), { bothBases: true });
    assert.deepEqual(abs.findings, []);
    const added = compare(extractHtml('<main><p>Read docs.</p></main>'), extractMarkdown('Read <a href="/added">docs</a>.\n'));
    assert.deepEqual(codes(added.findings), ['LINK_ADDED']);
    const missing = compare(extractHtml('<main><p>Read <a href="/docs">docs</a>.</p></main>'), extractMarkdown('Read <span>docs</span>.\n'));
    assert.deepEqual(codes(missing.findings), ['LINK_MISSING']);
    const changed = compare(extractHtml('<main><p>Read <a href="/old">docs</a>.</p></main>'), extractMarkdown('Read <a href="/new">docs</a>.\n'));
    assert.deepEqual(codes(changed.findings), ['LINK_TARGET_CHANGED']);
    // Child inlineCode, img alt, br and plain spans keep the Markdown text intact.
    const m = extractMarkdown('Use <a href="/api">`fetch()` <img alt="icon" src="/i.png"></a> and <em>more</em><br>here.\n');
    assert.equal(m.blocks[0]?.text, 'Use fetch() icon and more here.');
    assert.deepEqual(m.blocks[0]?.links.map((l) => [l.text, l.rawHref]), [['fetch() icon', '/api']]);
    // Unclosed anchor: coverage warning, strict fails, text is kept.
    const open = compare(extractHtml('<main><p>Read docs now.</p></main>'), extractMarkdown('Read <a href="/x">docs now.\n'));
    assert.deepEqual(codes(open.findings), ['MARKDOWN_INLINE_HTML_UNSUPPORTED']);
    assert.equal(open.findings[0]?.severity, 'warning');
    assert.equal(open.findings[0]?.markdown?.line, 1);
  });
});

describe('extraction edge cases', () => {
  it('empty main content yields zero blocks', () => {
    const f = fixture('empty-main');
    const h = extractHtml(f.html);
    assert.equal(h.blocks.length, 0);
  });
  it('a selector that matches nothing throws', () => {
    const f = fixture('same');
    assert.throws(() => extractHtml(f.html, { selector: '#does-not-exist' }), HtmlExtractError);
    assert.throws(() => extractHtml(f.html, { selector: '[[[' }), HtmlExtractError);
  });
  it('a selector with several matches uses the first and says so', () => {
    const h = extractHtml('<body><div class="c"><p>A</p></div><div class="c"><p>B</p></div></body>', { selector: '.c' });
    assert.deepEqual(h.blocks.map((b) => b.text), ['A']);
    assert.match(h.notes[0] ?? '', /matched 2 elements/);
  });
  it('falls back to body with low confidence and a warning finding', () => {
    const h = extractHtml('<html><body><nav>x</nav><div><p>Only body</p></div></body></html>');
    assert.equal(h.confidence, 'low');
    assert.equal(h.strategy, 'body-fallback');
    const r = compare(h, extractMarkdown('Only body\n'));
    assert.deepEqual(codes(r.findings), ['EXTRACTION_LOW_CONFIDENCE']);
    assert.equal(r.findings[0]?.severity, 'warning');
  });
  it('same text as paragraph and as list item is a structure warning, not missing content', () => {
    const r = compare(extractHtml('<main><p>Item</p></main>'), extractMarkdown('- Item\n'));
    assert.deepEqual(codes(r.findings), ['STRUCTURE_CHANGED']);
  });
  it('heading level change is a warning', () => {
    const r = compare(extractHtml('<main><h2>T</h2></main>'), extractMarkdown('# T\n'));
    assert.deepEqual(codes(r.findings), ['HEADING_LEVEL_CHANGED']);
  });
  it('typographic-only differences are warnings, wording differences are errors', () => {
    const r1 = compare(extractHtml('<main><p>It’s “fine”.</p></main>'), extractMarkdown('It\'s "fine".\n'));
    assert.deepEqual(codes(r1.findings), ['TEXT_MINOR_CHANGED']);
    const r2 = compare(extractHtml('<main><p>The audit reads every line of the page.</p></main>'), extractMarkdown('The audit reads most lines of the page.\n'));
    assert.deepEqual(codes(r2.findings), ['TEXT_CHANGED', 'ALIGNMENT_UNCERTAIN']);
    assert.equal(r2.findings[0]?.severity, 'error');
    assert.equal(r2.findings[1]?.severity, 'warning');
  });
  it('findings are deterministic across runs', () => {
    const a = runFixture('links').findings;
    const b = runFixture('links').findings;
    assert.deepEqual(a, b);
  });
});
