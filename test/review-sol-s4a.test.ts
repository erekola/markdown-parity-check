// Regression tests for the S4 part A triage (MP-02 to MP-10 and MP-17, then the N-1 list-context cases at the end): the inline HTML tag reader, the stack of raw
// HTML wrappers that stay open between Markdown blocks, the list context of raw HTML and of non-paragraph item
// leads, the Starlight tabs root with --selector, the task checkbox with an excluded role, and CR-only line breaks.
// A test whose name ends in "(control)" pins behaviour that must not change; the others are written to fail on the 0.2.33 behaviour they change.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractHtml } from '../src/html.js';
import { extractMarkdown } from '../src/markdown.js';
import { run, type Report, type SourceInput } from '../src/run.js';

const input = (body: string): SourceInput => ({ body, base: 'https://example.com/docs/', meta: { kind: 'file', file: 'fixture', bytes: Buffer.byteLength(body) } });

interface Opts {
  profile?: 'generic' | 'starlight';
  selector?: string;
}

/** Strict file-mode run; the HTML is wrapped in <main> so that the page has a main-content root. */
function check(html: string, md: string, o: Opts = {}): Report {
  return run(input(`<main>${html}</main>`), input(md), { mode: 'offline', strict: true, htmlProfile: o.profile, selector: o.selector });
}

const loud = (r: Report) => r.findings.filter((f) => f.severity !== 'info').map((f) => f.code);
const all = (r: Report) => r.findings.map((f) => f.code);

function passes(r: Report): void {
  assert.deepEqual(loud(r), []);
  assert.equal(r.summary.exitCode, 0);
}

describe('MP-02: a quoted > inside an inline HTML tag', () => {
  it('MP-02 an inline anchor whose title holds a quoted > keeps its link', () => {
    passes(check('<p>See <a href="/x" title="A > B">guide</a>.</p>', 'See <a href="/x" title="A > B">guide</a>.'));
  });
  it('MP-02 a hidden inline span with a quoted > in another attribute stays hidden', () => {
    passes(check('<p>Keep <span hidden data-x="a>b">SECRET</span> this.</p>', 'Keep <span hidden data-x="a>b">SECRET</span> this.'));
  });
  it('MP-02 an inline anchor whose title has no > (control)', () => {
    passes(check('<p>See <a href="/x" title="A B">guide</a>.</p>', 'See <a href="/x" title="A B">guide</a>.'));
  });
  it('MP-02 an inline anchor whose title writes the > as an entity (control)', () => {
    passes(check('<p>See <a href="/x" title="A &gt; B">guide</a>.</p>', 'See <a href="/x" title="A &gt; B">guide</a>.'));
  });
  it('MP-02 a missing link is still reported when the quoted > tag is read (control)', () => {
    const r = check('<p>See <a href="/x" title="A > B">guide</a>.</p>', 'See guide.');
    assert.ok(all(r).includes('LINK_MISSING'));
  });
});

describe('MP-03: excluded raw HTML wrappers hide the Markdown blocks between their tags', () => {
  it('MP-03 a nav wrapper around a Markdown block', () => {
    passes(check('<nav><p>Secret</p></nav><p>Public</p>', '<nav>\n\nSecret\n\n</nav>\n\nPublic'));
  });
  it('MP-03 a form wrapper around a Markdown block', () => {
    passes(check('<form><p>Secret</p></form><p>Public</p>', '<form>\n\nSecret\n\n</form>\n\nPublic'));
  });
  it('MP-03 a div with role navigation around a Markdown block', () => {
    passes(check('<div role="navigation"><p>Secret</p></div><p>Public</p>', '<div role="navigation">\n\nSecret\n\n</div>\n\nPublic'));
  });
  it('MP-03 a hidden div wrapper (control)', () => {
    passes(check('<div hidden><p>Secret</p></div><p>Public</p>', '<div hidden>\n\nSecret\n\n</div>\n\nPublic'));
  });
  it('MP-03 an aside wrapper is content, so both sides show its block (control)', () => {
    passes(check('<aside><p>Note</p></aside><p>Public</p>', '<aside>\n\nNote\n\n</aside>\n\nPublic'));
  });
  it('MP-03 a block after the closing tag is compared again (control)', () => {
    const r = check('<nav><p>Secret</p></nav><p>Public</p>', '<nav>\n\nSecret\n\n</nav>\n\nPublic\n\nExtra block here.');
    assert.ok(all(r).includes('BLOCK_ADDED'));
  });
  it('MP-03 a Markdown block inside the open nav is not reported as added, a block outside it still is', () => {
    const r = check('<p>Public</p>', '<nav>\n\nSecret\n\n</nav>\n\nPublic\n\nExtra block here.');
    assert.deepEqual(all(r).filter((c) => c === 'BLOCK_ADDED').length, 1);
  });
});

describe('MP-04: an excluded raw HTML block is not a skipped-text warning', () => {
  for (const tag of ['nav', 'form', 'dialog', 'iframe', 'textarea']) {
    it(`MP-04 <${tag}>Copy</${tag}> passes strict`, () => {
      const r = check('<p>Public</p>', `<${tag}>Copy</${tag}>\n\nPublic`);
      assert.ok(!all(r).includes('MARKDOWN_RAW_HTML_SKIPPED'), all(r).join());
      passes(r);
    });
  }
  it('MP-04 a script block stays silent (control)', () => {
    passes(check('<p>Public</p>', '<script>var a = 1;</script>\n\nPublic'));
  });
  it('MP-04 text the extractor does not read still warns, a header directly under the fragment body (control)', () => {
    const ex = extractMarkdown('<header>Site name</header>\n\nPublic');
    assert.ok(ex.issues.some((i) => i.code === 'MARKDOWN_RAW_HTML_SKIPPED'));
  });
});

describe('MP-07: a closing tag of a visible ancestor closes a hidden wrapper', () => {
  const HTML = '<p>Before</p><ul><li hidden><p>Secret</p></li></ul><p>Public</p>';
  it('MP-07 </ul> closes an implicitly open hidden li', () => {
    passes(check(HTML, 'Before\n\n<ul>\n\n<li hidden>\n\nSecret\n\n</ul>\n\nPublic'));
  });
  it('MP-07 an explicit </li> (control)', () => {
    passes(check(HTML, 'Before\n\n<ul>\n\n<li hidden>\n\nSecret\n\n</li>\n\n</ul>\n\nPublic'));
  });
});

describe('MP-08: a visible raw anchor around Markdown blocks gives them its link', () => {
  it('MP-08 a paragraph between <a href> and </a>', () => {
    passes(check('<a href="/doc"><p>Guide</p></a>', '<a href="/doc">\n\nGuide\n\n</a>'));
  });
  it('MP-08 a heading between <a href> and </a>', () => {
    passes(check('<a href="/doc"><h2>Guide</h2></a>', '<a href="/doc">\n\n## Guide\n\n</a>'));
  });
  it('MP-08 the link does not reach the block after </a>', () => {
    passes(check('<a href="/doc"><p>Guide</p></a><p>After</p>', '<a href="/doc">\n\nGuide\n\n</a>\n\nAfter'));
  });
  it('MP-08 reverse: a raw anchor in the Markdown over an anchorless HTML paragraph is LINK_ADDED', () => {
    const r = check('<p>Guide</p>', '<a href="/doc">\n\nGuide\n\n</a>');
    assert.ok(all(r).includes('LINK_ADDED'), all(r).join());
  });
  it('MP-08 a plain Markdown link against the HTML anchor paragraph (control)', () => {
    passes(check('<p><a href="/doc">Guide</a></p>', '[Guide](/doc)'));
  });
  it('MP-08 a span card in an anchor (control)', () => {
    passes(check('<a href="/doc"><span>Guide</span> <span>Body</span></a>', '[Guide Body](/doc)'));
  });
  it('MP-08 a different href is a changed target', () => {
    const r = check('<a href="/doc"><p>Guide</p></a>', '<a href="/other">\n\nGuide\n\n</a>');
    assert.ok(all(r).includes('LINK_TARGET_CHANGED'), all(r).join());
  });
});

describe('MP-05: raw HTML in a Markdown list item keeps the list context', () => {
  it('MP-05 a raw paragraph in a bullet item is the item text', () => {
    passes(check('<ul><li><p>Hello</p></li></ul>', '- <p>Hello</p>'));
  });
  it('MP-05 a raw nested list in an item has the nesting level of the item', () => {
    passes(check('<ul><li>Outer<ul><li>Inner</li></ul></li></ul>', '- Outer\n\n  <ul><li>Inner</li></ul>'));
  });
  it('MP-05 a raw paragraph in a numbered item keeps the number', () => {
    passes(check('<ol start="3"><li><p>Hello</p></li></ol>', '3. <p>Hello</p>'));
  });
  it('MP-05 a raw paragraph in a numbered item with another number is LIST_NUMBER_CHANGED', () => {
    const r = check('<ol start="3"><li><p>Hello</p></li></ol>', '1. <p>Hello</p>');
    assert.ok(all(r).includes('LIST_NUMBER_CHANGED'), all(r).join());
  });
  it('MP-05 an inline span in a bullet item (control)', () => {
    passes(check('<ul><li>Hello</li></ul>', '- <span>Hello</span>'));
  });
  it('MP-05 a native nested list (control)', () => {
    passes(check('<ul><li>Outer<ul><li>Inner</li></ul></li></ul>', '- Outer\n  - Inner'));
  });
  it('MP-05 a raw nested list in an item is level 2, so the same list written at level 1 warns', () => {
    const r = check('<ul><li>Outer</li></ul><ul><li>Inner</li></ul>', '- Outer\n\n  <ul><li>Inner</li></ul>');
    assert.ok(loud(r).length > 0);
  });
});

describe('MP-06: a list item that does not start with a paragraph keeps its list context', () => {
  it('MP-06 a numbered item that starts with a heading compares its number', () => {
    const r = check('<ol start="2"><li><h2>Hello</h2></li></ol>', '1. ## Hello');
    assert.deepEqual(loud(r), ['LIST_NUMBER_CHANGED']);
    assert.equal(r.summary.exitCode, 1);
  });
  it('MP-06 a numbered item that starts with code compares its number', () => {
    const r = check('<ol start="2"><li><pre>code</pre></li></ol>', '1. ```\n   code\n   ```');
    assert.deepEqual(loud(r), ['LIST_NUMBER_CHANGED']);
  });
  it('MP-06 a numbered item that starts with a table compares its number', () => {
    const r = check('<ol start="2"><li><table><tr><td>a</td><td>b</td></tr></table></li></ol>', '1. | a | b |\n   | - | - |');
    assert.deepEqual(loud(r), ['LIST_NUMBER_CHANGED']);
  });
  it('MP-06 a bullet heading item against a numbered one is LIST_KIND_CHANGED', () => {
    const r = check('<ul><li><h2>Hello</h2></li></ul>', '1. ## Hello');
    assert.deepEqual(loud(r), ['LIST_KIND_CHANGED']);
  });
  it('MP-06 equal numbers pass (control)', () => {
    passes(check('<ol start="2"><li><h2>Hello</h2></li></ol>', '2. ## Hello'));
    passes(check('<ol start="2"><li><pre>code</pre></li></ol>', '2. ```\n   code\n   ```'));
    passes(check('<ol start="2"><li><table><tr><td>a</td><td>b</td></tr></table></li></ol>', '2. | a | b |\n   | - | - |'));
  });
  it('MP-06 a paragraph item with another number already fails (control)', () => {
    const r = check('<ol start="2"><li>Hello</li></ol>', '1. Hello');
    assert.deepEqual(loud(r), ['LIST_NUMBER_CHANGED']);
  });
  it('MP-06 a nested list as the first child gives the outer item no list context (control)', () => {
    passes(check('<ol><li><ul><li>x</li></ul></li></ol>', '1. - x'));
  });
});

describe('MP-09: --selector on a Starlight tabs root with the Starlight profile', () => {
  const ec = (line: string) => `<div class="expressive-code"><figure><figcaption><span class="title"></span><span class="sr-only">Terminal window</span></figcaption><pre><code><div class="ec-line"><div class="code">${line}</div></div></code></pre></figure></div>`;
  const tabHtml = `<starlight-tabs><div><ul role="tablist"><li><a role="tab" id="t1" href="#p1">npm</a></li><li><a role="tab" id="t2" href="#p2">pnpm</a></li></ul></div><div role="tabpanel" id="p1" aria-labelledby="t1">${ec('npm install sample')}</div><div role="tabpanel" id="p2" aria-labelledby="t2" hidden>${ec('pnpm add sample')}</div></starlight-tabs>`;
  const tabMd = '* npm\n\n  ```sh\n  npm install sample\n  ```\n\n* pnpm\n\n  ```sh\n  pnpm add sample\n  ```';
  it('MP-09 the tabs root is read by the profile handler', () => {
    passes(check(tabHtml, tabMd, { profile: 'starlight', selector: 'starlight-tabs' }));
  });
  it('MP-09 without --selector (control)', () => {
    passes(check(tabHtml, tabMd, { profile: 'starlight' }));
  });
  it('MP-09 the generic profile with the selector is unchanged (control)', () => {
    const r = check(tabHtml, tabMd, { selector: 'starlight-tabs' });
    assert.equal(r.summary.exitCode, 1);
  });
  it('MP-09 the selector reads the same blocks as the page walk', () => {
    const page = extractHtml(`<main>${tabHtml}</main>`, { profile: 'starlight' });
    const picked = extractHtml(`<main>${tabHtml}</main>`, { profile: 'starlight', selector: 'starlight-tabs' });
    assert.deepEqual(picked.blocks.map((b) => [b.type, b.text]), page.blocks.map((b) => [b.type, b.text]));
  });
});

describe('MP-10: a task checkbox with an excluded role of its own', () => {
  it('MP-10 a checked checkbox with role navigation is not the item state', () => {
    passes(check('<ul><li><input type="checkbox" role="navigation" checked> Done</li></ul>', '- Done'));
  });
  it('MP-10 a checked checkbox with aria-hidden (control)', () => {
    passes(check('<ul><li><input type="checkbox" aria-hidden="true" checked> Done</li></ul>', '- Done'));
  });
  it('MP-10 a checked checkbox without a role still differs from a plain item (control)', () => {
    const r = check('<ul><li><input type="checkbox" checked> Done</li></ul>', '- Done');
    assert.deepEqual(loud(r), ['LIST_TASK_CHANGED']);
  });
  it('MP-10 a role that is not excluded does not hide the checkbox (control)', () => {
    const r = check('<ul><li><input type="checkbox" role="presentation" checked> Done</li></ul>', '- Done');
    assert.deepEqual(loud(r), ['LIST_TASK_CHANGED']);
  });
  it('MP-10 a later visible checkbox answers for the item after an excluded one', () => {
    passes(check('<ul><li><input type="checkbox" role="navigation" checked><input type="checkbox"> Done</li></ul>', '- [ ] Done'));
  });
});

describe('MP-17: CR-only line breaks count as one line break each', () => {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const htmlLf = '<main>\n<p>Keep.</p>\n<p>Only HTML.</p>\n</main>';
  const lineOfHtml = (src: string) => extractHtml(src).blocks.find((b) => b.text === 'Only HTML.')?.location.line;
  const mdLf = 'Keep.\n\n<div>\n<p>Only Markdown.</p>\n</div>\n';
  const lineOfMd = (src: string) => extractMarkdown(src).blocks.find((b) => b.text === 'Only Markdown.')?.location.line;
  it('MP-17 HTML with CR-only breaks locates the block on line 3', () => {
    assert.equal(lineOfHtml(htmlLf.split(LF).join(CR)), 3);
  });
  it('MP-17 HTML with CRLF and with LF (control)', () => {
    assert.equal(lineOfHtml(htmlLf), 3);
    assert.equal(lineOfHtml(htmlLf.split(LF).join(CR + LF)), 3);
  });
  it('MP-17 HTML that mixes CR-only and CRLF counts every break once', () => {
    const mixed = '<main>' + CR + '<p>Keep.</p>' + CR + LF + '<p>Only HTML.</p>' + CR + '</main>';
    assert.equal(lineOfHtml(mixed), 3);
  });
  it('MP-17 raw HTML in CR-only Markdown locates the block on line 4', () => {
    assert.equal(lineOfMd(mdLf.split(LF).join(CR)), 4);
  });
  it('MP-17 raw HTML in LF and CRLF Markdown (control)', () => {
    assert.equal(lineOfMd(mdLf), 4);
    assert.equal(lineOfMd(mdLf.split(LF).join(CR + LF)), 4);
  });
  it('MP-17 the parsed-HTML issue of a CR-only Markdown block carries the same line as the LF one (control)', () => {
    const issueLine = (src: string) => extractMarkdown(src).issues.find((i) => i.code === 'MARKDOWN_RAW_HTML_PARSED')?.line;
    assert.equal(issueLine(mdLf.split(LF).join(CR)), issueLine(mdLf));
  });
});

describe('N-1: raw HTML in a list item gets the list context only where the HTML side gives it', () => {
  for (const tag of ['div', 'blockquote', 'section', 'details']) {
    it(`N-1 <${tag}>x</${tag}> in a bullet item is only an info finding under --strict`, () => {
      const r = check(`<ul><li><${tag}>x</${tag}></li></ul>`, `- <${tag}>x</${tag}>`);
      passes(r);
      assert.ok(!all(r).includes('STRUCTURE_CHANGED'), all(r).join());
    });
  }
  it('N-1 a raw <p> in a numbered item still compares the number (control)', () => {
    const r = check('<ol start="3"><li><p>Hello</p></li></ol>', '1. <p>Hello</p>');
    assert.ok(all(r).includes('LIST_NUMBER_CHANGED'), all(r).join());
  });
  it('N-1 a raw <h2> in a numbered item still compares the number (control)', () => {
    const r = check('<ol start="2"><li><h2>Hello</h2></li></ol>', '1. <h2>Hello</h2>');
    assert.ok(all(r).includes('LIST_NUMBER_CHANGED'), all(r).join());
  });
});
