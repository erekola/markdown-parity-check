// A link whose children hold a block element (a linked card) is a container, not one run of inline text. Up to 0.2.29
// the card's heading was flattened into the paragraph around it: a faithful Markdown card failed with four errors
// and a Markdown copy that wrote the title as a plain linked paragraph passed, also under --strict (found on real
// sites, 2026-11-02). Ten of the 17 tests were written to fail on the 0.2.29 code; the other seven pin behaviour that must not change
// (inline anchors, an anchor without href, hidden block children, the plain-paragraph list item, the table cell).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare } from '../src/compare.js';
import { extractHtml } from '../src/html.js';
import { extractMarkdown } from '../src/markdown.js';
import type { Finding } from '../src/model.js';

const BASE = 'https://example.com/page';
const X = 'https://example.com/x';

function run(html: string, md: string) {
  const h = extractHtml(`<!doctype html><html><head><title>T</title></head><body>${html}</body></html>`, { baseUrl: BASE });
  const m = extractMarkdown(md, { baseUrl: BASE });
  const r = compare(h, m, { bothBases: true });
  return { h, m, ...r };
}

const errors = (fs: Finding[]) => fs.filter((f) => f.severity === 'error');
const loud = (fs: Finding[]) => fs.filter((f) => f.severity === 'error' || f.severity === 'warning');

const CARD = `<main><h1>Top</h1><a href="${X}"><h2>Card title</h2><p>Card body text here.</p></a></main>`;
const CARD_MD = `# Top\n\n## [Card title](${X})\n\n[Card body text here.](${X})\n`;

describe('block anchor: the fixtures of the fault', () => {
  it('a faithful linked card passes with no error and no warning', () => {
    const r = run(CARD, CARD_MD);
    assert.deepEqual(r.findings.map((f) => f.code), []);
    assert.equal(r.h.blocks.length, 3);
  });
  it('the card heading stays a heading of its depth, and the body a paragraph, each with its own link text', () => {
    const { h } = run(CARD, CARD_MD);
    const [top, title, body] = h.blocks;
    assert.equal(top?.type, 'heading');
    assert.equal(title?.type, 'heading');
    assert.equal(title?.depth, 2);
    assert.equal(title?.text, 'Card title');
    assert.deepEqual(title?.links.map((l) => [l.text, l.rawHref, l.resolved]), [['Card title', X, X]]);
    assert.equal(body?.type, 'paragraph');
    assert.deepEqual(body?.links.map((l) => [l.text, l.rawHref]), [['Card body text here.', X]]);
  });
  it('a heading inside a card no longer vanishes into a plain linked paragraph (the false pass)', () => {
    const html = `<main><h1>Top</h1><a href="${X}"><h2>Card title</h2></a><p>Intro text here.</p></main>`;
    const md = `# Top\n\n[Card title](${X})\n\nIntro text here.\n`;
    const r = run(html, md);
    assert.ok(errors(r.findings).length > 0);
    assert.ok(loud(r.findings).length > 0);
  });
  it('the same heading without the anchor still fails, as before', () => {
    const r = run('<main><h1>Top</h1><h2>Card title</h2><p>Intro text here.</p></main>', `# Top\n\n[Card title](${X})\n\nIntro text here.\n`);
    assert.ok(errors(r.findings).length >= 2);
  });
});

describe('block anchor: shapes', () => {
  it('a heading-only anchor matches a linked heading', () => {
    const r = run(`<main><h1>Top</h1><a href="${X}"><h2>Card title</h2></a></main>`, `# Top\n\n## [Card title](${X})\n`);
    assert.deepEqual(r.findings.map((f) => f.code), []);
    assert.equal(r.h.blocks[1]?.type, 'heading');
  });
  it('an anchor with two headings gives two linked headings', () => {
    const r = run(`<main><h1>Top</h1><a href="${X}"><h2>First part</h2><h3>Second part</h3></a></main>`, `# Top\n\n## [First part](${X})\n\n### [Second part](${X})\n`);
    assert.deepEqual(r.findings.map((f) => f.code), []);
    assert.deepEqual(r.h.blocks.slice(1).map((b) => [b.type, b.depth, b.links.length]), [['heading', 2, 1], ['heading', 3, 1]]);
  });
  it('an inline anchor is unchanged: one run, the link text is the anchor text', () => {
    const r = run(`<main><h1>Top</h1><p>See <a href="${X}">the page</a> now.</p></main>`, `# Top\n\nSee [the page](${X}) now.\n`);
    assert.deepEqual(r.findings.map((f) => f.code), []);
    assert.equal(r.h.blocks.length, 2);
    assert.deepEqual(r.h.blocks[1]?.links.map((l) => l.text), ['the page']);
  });
  it('an anchor with spans only stays one paragraph block', () => {
    const r = run(`<main><h1>Top</h1><a href="${X}"><span>Card</span> <span>label</span></a></main>`, `# Top\n\n[Card label](${X})\n`);
    assert.deepEqual(r.findings.map((f) => f.code), []);
    assert.equal(r.h.blocks.length, 2);
  });
  it('an anchor without href stays as it is: inline text, no link recorded', () => {
    const { h } = run('<main><h1>Top</h1><a><h2>Card title</h2></a></main>', `# Top\n\nCard title\n`);
    assert.equal(h.blocks.length, 2);
    assert.equal(h.blocks[1]?.type, 'paragraph');
    assert.deepEqual(h.blocks[1]?.links, []);
  });
  it('an anchor whose block children are all hidden stays inline text', () => {
    const { h } = run(`<main><h1>Top</h1><a href="${X}"><div hidden>secret</div>Visible</a></main>`, `# Top\n\n[Visible](${X})\n`);
    assert.equal(h.blocks.length, 2);
    assert.equal(h.blocks[1]?.type, 'paragraph');
    assert.equal(h.blocks[1]?.text, 'Visible');
  });
  it('a block anchor inside a paragraph splits it into blocks', () => {
    const { h } = run(`<main><h1>Top</h1><p>Before <a href="${X}"><h2>Card title</h2></a> after</p></main>`, `# Top\n\nBefore\n\n## [Card title](${X})\n\nafter\n`);
    assert.deepEqual(h.blocks.slice(1).map((b) => [b.type, b.text]), [['paragraph', 'Before'], ['heading', 'Card title'], ['paragraph', 'after']]);
  });
  it('a list item with a card anchor: the item is a block child, heading and paragraph keep their links', () => {
    const html = `<main><h1>Top</h1><ul><li><a href="${X}"><h3>Card title</h3><p>Card body text here.</p></a></li></ul></main>`;
    const { h } = run(html, `# Top\n\n- ### [Card title](${X})\n\n  [Card body text here.](${X})\n`);
    assert.deepEqual(h.blocks.slice(1).map((b) => [b.type, b.depth ?? null, b.text, b.links.map((l) => l.text)]), [
      ['heading', 3, 'Card title', ['Card title']],
      ['paragraph', null, 'Card body text here.', ['Card body text here.']],
    ]);
  });
  it('a list item whose link holds one plain paragraph stays a list item, as before', () => {
    const r = run(`<main><h1>Top</h1><ul><li><a href="${X}"><p>Only text</p></a></li></ul></main>`, `# Top\n\n- [Only text](${X})\n`);
    assert.deepEqual(r.findings.map((f) => f.code), []);
    assert.equal(r.h.blocks[1]?.type, 'listItem');
    assert.deepEqual(r.h.blocks[1]?.links.map((l) => l.text), ['Only text']);
  });
  it('a table cell keeps flattening a card anchor into the cell text', () => {
    const { h } = run(`<main><h1>Top</h1><table><tr><td><a href="${X}"><h2>Card title</h2><p>Body</p></a></td><td>2</td></tr></table></main>`, `# Top\n\n| a | b |\n| - | - |\n| [Card title Body](${X}) | 2 |\n`);
    const table = h.blocks[1];
    assert.equal(table?.type, 'table');
    assert.deepEqual(table?.cells, [['Card title Body', '2']]);
    assert.deepEqual(table?.links.map((l) => l.text), ['Card title Body']);
  });
});

describe('block anchor: a mismatch inside a card is still caught', () => {
  // Each case names the one finding the change causes. Up to 0.2.29 the card was already four errors before any
  // change, so none of these differences could be told apart.
  it('a changed body text is a text change of that paragraph only', () => {
    const r = run(CARD, CARD_MD.replace('Card body text here.', 'Card body text changed.'));
    assert.ok(r.findings.some((f) => f.code === 'TEXT_CHANGED' && f.severity === 'error'));
    assert.equal(r.findings.some((f) => f.code === 'BLOCK_ADDED' || f.code === 'BLOCK_MISSING'), false);
  });
  it('a changed link target is reported once for the heading and once for the paragraph, as that and nothing else', () => {
    const r = run(CARD, CARD_MD.split(X).join('https://example.com/y'));
    assert.deepEqual(r.findings.map((f) => `${f.severity}:${f.code}`), ['error:LINK_TARGET_CHANGED', 'error:LINK_TARGET_CHANGED']);
  });
  it('a changed heading level is a heading level warning and nothing else', () => {
    const r = run(CARD, CARD_MD.replace('## [Card title]', '### [Card title]'));
    assert.deepEqual(r.findings.map((f) => `${f.severity}:${f.code}`), ['warning:HEADING_LEVEL_CHANGED']);
  });
});
