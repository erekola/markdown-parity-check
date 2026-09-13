import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractHtml, HtmlExtractError } from '../src/html.js';
import { parseCliArgs } from '../src/cli.js';
import { run, RunError, type SourceInput } from '../src/run.js';

const ec = (lines: string[]) => `<div class="expressive-code"><figure><figcaption><span class="title"></span><span class="sr-only">Terminal window</span></figcaption><pre><code>${lines.map((line) => `<div class="ec-line"><div class="code">${line}</div></div>`).join('')}</code></pre></figure></div>`;
const tabHtml = `<starlight-tabs><div><ul role="tablist"><li><a role="tab" id="t1" href="#p1">npm</a></li><li><a role="tab" id="t2" href="#p2">pnpm</a></li></ul></div><div role="tabpanel" id="p1" aria-labelledby="t1">${ec(['npm install sample'])}</div><div role="tabpanel" id="p2" aria-labelledby="t2" hidden>${ec(['pnpm add sample'])}</div></starlight-tabs>`;
const tabMd = '* npm\n\n  ```sh\n  npm install sample\n  ```\n\n* pnpm\n\n  ```sh\n  pnpm add sample\n  ```';
const input = (body: string): SourceInput => ({ body, base: 'https://example.com/docs/', meta: { kind: 'file', file: 'fixture', bytes: Buffer.byteLength(body) } });
const compare = (html: string, md: string, profile: 'generic' | 'starlight' = 'starlight') => run(input(`<main>${html}</main>`), input(md), { mode: 'offline', strict: true, htmlProfile: profile });

describe('opt-in Starlight extraction', () => {
  it('keeps generic extraction unchanged when no profile is supplied', () => {
    const html = `<main>${ec(['let n = 1;', 'print(n);'])}</main>`;
    assert.deepEqual(extractHtml(html), extractHtml(html, { profile: 'generic' }));
    assert.equal(compare(ec(['let n = 1;', 'print(n);']), '```js\nlet n = 1;\nprint(n);\n```', 'generic').summary.exitCode, 1);
  });
  it('preserves Expressive Code lines, blank lines, indentation and decoded entities', () => {
    const report = compare(ec(['if (a &lt; b) {', '', '  print(a);', '}']), '```js\nif (a < b) {\n\n  print(a);\n}\n```');
    assert.equal(report.summary.exitCode, 0, JSON.stringify(report.findings));
    assert.match(report.extraction!.html.strategy, /profile:starlight/);
    assert.match(report.extraction!.html.notes.join(' '), /inactive panels/);
  });
  it('detects a changed token inside a highlighted line', () => {
    const report = compare(ec(['let n = 1;', 'print(n);']), '```js\nlet n = 2;\nprint(n);\n```');
    assert.equal(report.summary.exitCode, 1);
    assert.ok(report.findings.some((f) => f.code === 'TEXT_CHANGED'));
  });
  it('does not drop extra code children to accept an incomplete Markdown sample', () => {
    const html = ec(['one', 'two']).replace('</code>', '<span>EXTRA</span></code>');
    assert.equal(compare(html, '```\none\ntwo\n```').summary.exitCode, 1);
  });
  it('does not reinterpret unrelated div wrappers as Expressive Code lines', () => {
    const html = '<pre><code><div>one</div><div>two</div></code></pre>';
    const generic = extractHtml(`<main>${html}</main>`).blocks;
    assert.deepEqual(extractHtml(`<main>${html}</main>`, { profile: 'starlight' }).blocks, generic);
  });
  it('retains a code filename while omitting the terminal-frame UI label', () => {
    const html = ec(['hello']).replace('<span class="title"></span>', '<span class="title">hello.sh</span>');
    assert.equal(compare(html, 'hello.sh\n\n```sh\nhello\n```').summary.exitCode, 0);
    assert.equal(compare(html, '```sh\nhello\n```').summary.exitCode, 1);
  });
  it('compares both associated tab panels as labelled list items', () => {
    const report = compare(tabHtml, tabMd);
    assert.equal(report.summary.exitCode, 0, JSON.stringify(report.findings));
    assert.equal(report.summary.coverage!.htmlRatio, 1);
    assert.equal(report.summary.coverage!.markdownRatio, 1);
  });
  it('detects missing inactive-panel content', () => {
    const report = compare(tabHtml, tabMd.replace('  pnpm add sample\n', ''));
    assert.equal(report.summary.exitCode, 1);
    assert.ok(report.findings.some((f) => f.code === 'BLOCK_MISSING'));
  });
  it('detects changed inactive-panel code', () => {
    assert.equal(compare(tabHtml, tabMd.replace('pnpm add sample', 'pnpm remove sample')).summary.exitCode, 1);
  });
  it('detects changed tab labels', () => {
    assert.equal(compare(tabHtml, tabMd.replace('* pnpm', '* yarn')).summary.exitCode, 1);
  });
  it('supports explicit aria-controls associations', () => {
    assert.equal(compare(tabHtml.replace('href="#p1"', 'aria-controls="p1"'), tabMd).summary.exitCode, 0);
  });
  it('refuses missing panels', () => {
    assert.throws(() => compare(tabHtml.replace('role="tabpanel" id="p2"', 'role="region" id="p2"'), tabMd), RunError);
  });
  it('refuses duplicate tab identifiers', () => {
    assert.throws(() => compare(tabHtml.replace('id="t2"', 'id="t1"'), tabMd), /ambiguous/);
  });
  it('refuses duplicate or mismatched panel identifiers', () => {
    assert.throws(() => compare(tabHtml.replace('id="p2"', 'id="p1"'), tabMd), /ambiguous/);
  });
  it('refuses unexplained content outside the tab panels', () => {
    assert.throws(() => compare(tabHtml.replace('</starlight-tabs>', '<p>Important extra text</p></starlight-tabs>'), tabMd), /Unexpected text/);
  });
  it('does not expose hidden content outside panels or nested inside an included panel', () => {
    const html = tabHtml.replace('</starlight-tabs>', '</starlight-tabs><p hidden>Outside</p>')
      .replace('<div role="tabpanel" id="p2" aria-labelledby="t2" hidden>', '<div role="tabpanel" id="p2" aria-labelledby="t2" hidden><p hidden>Inside</p>');
    const report = compare(html, tabMd);
    assert.equal(report.summary.exitCode, 0, JSON.stringify(report.findings));
  });
  it('retains scoped aside titles but respects other aria-hidden elements', () => {
    const html = '<aside class="starlight-aside" aria-label="Caution"><p class="starlight-aside__title" aria-hidden="true">Caution</p><div><p>Keep 3 copies.</p></div></aside><p aria-hidden="true">Hidden</p>';
    assert.equal(compare(html, 'Caution\n\nKeep 3 copies.').summary.exitCode, 0);
    assert.equal(compare(html, 'Note\n\nKeep 3 copies.').summary.exitCode, 1);
  });
  it('keeps source locations tied to the original HTML', () => {
    const report = compare('\n' + tabHtml, tabMd.replace('pnpm add sample', 'pnpm remove sample'));
    assert.ok(report.findings.some((f) => f.html?.line === 2 && f.html.path?.includes('starlight-tabs')));
  });
  it('validates profile values in both API and CLI', () => {
    assert.throws(() => extractHtml('<main>x</main>', { profile: 'unknown' as 'generic' }), HtmlExtractError);
    assert.throws(() => parseCliArgs(['--url', 'https://example.com', '--html-profile', 'unknown']), /html-profile/);
    assert.equal(parseCliArgs(['--url', 'https://example.com']).htmlProfile, 'generic');
    assert.equal(parseCliArgs(['--url', 'https://example.com', '--html-profile', 'starlight']).htmlProfile, 'starlight');
  });
  it('preserves the nesting limit with the Starlight profile', () => {
    assert.throws(() => extractHtml('<main><div><p>Text</p></div></main>', { profile: 'starlight', maxDepth: 2 }), /nesting depth/);
  });
});
