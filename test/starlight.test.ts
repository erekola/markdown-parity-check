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
  it('keeps a tab and panel pair inside a hidden, noscript or aria-hidden wrapper hidden', () => {
    const pair = '<ul role="tablist"><li><a role="tab" id="t3" href="#p3">draft</a></li></ul><div role="tabpanel" id="p3" aria-labelledby="t3" hidden><p>Hidden draft</p></div>';
    const withDraft = tabMd + '\n\n* draft\n\n  Hidden draft';
    for (const [open, close] of [['<div hidden>', '</div>'], ['<noscript>', '</noscript>'], ['<div aria-hidden="true">', '</div>']] as const) {
      const html = tabHtml.replace('</starlight-tabs>', `${open}${pair}${close}</starlight-tabs>`);
      assert.equal(compare(html, tabMd).summary.exitCode, 0, open);
      assert.equal(compare(html, withDraft).summary.exitCode, 1, open);
    }
  });
  it('refuses a panel that is not a direct child of the tabs component', () => {
    for (const open of ['<div>', '<div aria-hidden="true">']) {
      const html = tabHtml.replace('<div role="tabpanel" id="p2"', `${open}<div role="tabpanel" id="p2"`).replace('</starlight-tabs>', '</div></starlight-tabs>');
      assert.throws(() => compare(html, tabMd), RunError, open);
    }
  });
  it('reads Expressive Code lines beside a line-number gutter without the numbers', () => {
    const numbered = (lines: string[]) => ec(lines).split('<div class="ec-line">').join('<div class="ec-line"><div class="gutter"><div class="ln" aria-hidden="true">9</div></div>');
    assert.equal(compare(numbered(['echo one', 'echo two']), '```sh\necho one\necho two\n```').summary.exitCode, 0);
    assert.equal(compare(numbered(['echo one', 'echo two']), '```sh\necho one\necho 2\n```').summary.exitCode, 1);
    const other = ec(['echo one']).replace('<div class="ec-line">', '<div class="ec-line"><div class="marker">X</div>');
    assert.equal(compare(other, '```sh\necho one\n```').summary.exitCode, 1);
  });
  it('reads an iframe with a source and a title as the link the exporter writes', () => {
    const html = tabHtml.replace(ec(['npm install sample']), '<iframe src="/files/npm.txt" title="npm file"></iframe>');
    const md = tabMd.replace('```sh\n  npm install sample\n  ```', '[npm file](/files/npm.txt)');
    assert.equal(compare(html, md).summary.exitCode, 0, JSON.stringify(compare(html, md).findings));
    assert.equal(compare(html, md.replace('[npm file]', '[yarn file]')).summary.exitCode, 1);
    assert.equal(compare(html, md.replace('(/files/npm.txt)', '(/files/yarn.txt)')).summary.exitCode, 1);
    assert.equal(compare(html, md.replace('  [npm file](/files/npm.txt)\n\n', '')).summary.exitCode, 1);
  });
  it('keeps an iframe without both a source and a title out of the comparison, and the generic profile unchanged', () => {
    assert.equal(compare('<p>Intro</p><iframe src="/x.txt"></iframe><iframe title="No source"></iframe>', 'Intro').summary.exitCode, 0);
    assert.equal(compare('<p>Intro</p><iframe src="/x.txt" title="A file"></iframe>', 'Intro', 'generic').summary.exitCode, 0);
  });
  it('refuses an iframe outside the tab panels', () => {
    assert.throws(() => compare(tabHtml.replace('</starlight-tabs>', '<iframe src="/x.txt" title="Stray"></iframe></starlight-tabs>'), tabMd), /Unexpected/);
  });
  it('prefixes Expressive Code ins and del lines the way the exporter does', () => {
    const block = (language: string, lines: string) => `<div class="expressive-code"><figure><pre data-language="${language}"><code>${lines}</code></pre></figure></div>`;
    const line = (cls: string, inner: string) => `<div class="ec-line${cls}"><div class="code">${inner}</div></div>`;
    const html = block('js', line('', '<span>import a</span>') + line(' highlight ins', '<span class="indent"><span>  </span></span><span>b()</span>') + line(' del', '<span>c()</span>') + line(' ins', ''));
    const md = '```diff\nimport a\n+  b()\n-c()\n\n```';
    assert.equal(compare(html, md).summary.exitCode, 0, JSON.stringify(compare(html, md).findings));
    assert.equal(compare(html, md.replace('+  b()', '-  b()')).summary.exitCode, 1);
    assert.equal(compare(html, md.replace('+  b()', '  b()')).summary.exitCode, 1);
  });
  it('adds no marker to a diff-language block or to a block without ins or del lines', () => {
    const block = (language: string, lines: string) => `<div class="expressive-code"><figure><pre data-language="${language}"><code>${lines}</code></pre></figure></div>`;
    const line = (cls: string, inner: string) => `<div class="ec-line${cls}"><div class="code">${inner}</div></div>`;
    assert.equal(compare(block('diff', line(' ins', '<span>+b</span>')), '```diff\n+b\n```').summary.exitCode, 0);
    assert.equal(compare(block('js', line(' mark', '<span>b</span>')), '```js\nb\n```').summary.exitCode, 0);
    assert.equal(compare(block('js', line(' ins', '<span>b</span>')), '```js\n+b\n```', 'generic').summary.exitCode, 1);
  });
});
