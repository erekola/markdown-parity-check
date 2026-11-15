// The comparison keys do not depend on the credential masking. The masking is a display safeguard, so what is compared
// (the normalized text, the link text, the numbers, the loose key) is what 0.2.38 computes for every input, and the
// masking works on separate display strings. The reference below is copied from 0.2.38.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractHtml } from '../src/html.js';
import { extractMarkdown } from '../src/markdown.js';
import { looseNormalize, strictNormalize } from '../src/normalize.js';
import { renderJson, renderText } from '../src/report.js';
import { run, type RunOptions, type SourceInput } from '../src/run.js';

const chars = (...codes: number[]): string => codes.map((c) => String.fromCodePoint(c)).join('');
const NBSP = new RegExp(`[${chars(0xa0, 0x2007, 0x202f)}]`, 'g');
const WS = /[ \t\r\n\f\v]+/g;
const ZERO_WIDTH = new RegExp(`[${chars(0x200b, 0xfeff, 0xad)}]`, 'g');
function referenceStrictNormalize(text: string): string {
  return text.normalize('NFC').replace(ZERO_WIDTH, '').replace(NBSP, ' ').replace(WS, ' ').trim();
}

const T = chars(9);
const LF = chars(10);
const VT = chars(11);
const FF = chars(12);
const CR = chars(13);
const NBSP_CHAR = chars(0xa0);
const breaks = [T, LF, VT, FF, CR, ' ', NBSP_CHAR, '', CR + LF];
const heads = ['https://usr:pa', 'https://example.com', 'https://a.example:8443', 'https://usr:', 'ftp://', 'x://u', 'https://'];
const tails = ['ss@host.example/', 'admin@example.org today.', 'ops@b.example', 'SECRET@h/p', '@h', 'pw@h:80/x?y=1'];

const corpus: string[] = ['', '://', 'a://b', 'plain text', 'two  spaces' + T + 'tab', `see https://u:p${T}q@h/ now`];
for (const h of heads) {
  for (const b of breaks) {
    for (const t of tails) corpus.push(h + b + t, `Visit ${h}${b}${t}`, `${h}${b}${t}${b}${t}`);
  }
}

const opts: RunOptions = { strict: false, mode: 'offline' };
const src = (body: string): SourceInput => ({ meta: { kind: 'file', bytes: body.length }, body, base: 'https://example.com/page' });
const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

describe('the comparison keys are the 0.2.38 keys for every input', () => {
  it('strictNormalize equals the 0.2.38 function on a corpus of address shapes with white space', () => {
    assert.ok(corpus.length > 1000);
    for (const s of corpus) assert.equal(strictNormalize(s), referenceStrictNormalize(s), JSON.stringify(s));
  });

  it('the text, the loose key and the link text of an extracted block are the 0.2.38 keys', () => {
    for (const s of corpus.filter((_, i) => i % 7 === 0)) {
      const expected = referenceStrictNormalize(s);
      for (const block of extractHtml(`<main><p>${escapeHtml(s)}</p></main>`).blocks) {
        assert.equal(block.text, expected, JSON.stringify(s));
        assert.equal(block.loose, looseNormalize(expected), JSON.stringify(s));
      }
      const withLink = extractHtml(`<main><p><a href="https://x.example/">${escapeHtml(s)}</a></p></main>`).blocks[0];
      if (withLink) assert.equal(withLink.links[0]!.text, expected, JSON.stringify(s));
      const flat = `para ${s.replace(/[\r\n]+/g, ' ')}`;
      for (const block of extractMarkdown(`${flat}\n`).blocks) assert.equal(block.text, referenceStrictNormalize(flat), JSON.stringify(s));
      for (const block of extractHtml(`<main><table><tr><td>${escapeHtml(s)}</td></tr></table></main>`).blocks) {
        assert.equal(block.cells![0]![0], expected, JSON.stringify(s));
      }
    }
  });

  it('a tab between an address and an e-mail address, against a space in the HTML, still passes (the 0.2.38 verdict)', () => {
    for (const w of [T, FF, VT]) {
      const html = '<main><p>Visit <a href="https://example.com">https://example.com</a> <a href="mailto:admin@example.org">admin@example.org</a> today.</p></main>';
      const md = `Visit https://example.com${w}admin@example.org today.\n`;
      assert.equal(run(src(html), src(md), opts).summary.exitCode, 0);
    }
  });

  it('a tab inside a password in the HTML link text, against a plain password in the Markdown, still fails with the 0.2.38 findings', () => {
    const html = '<main><p>Use <a href="https://usr:pass@host.example/">https://usr:pa&#9;ss@host.example/</a> now.</p></main>';
    const md = 'Use [https://usr:pass@host.example/](https://usr:pass@host.example/) now.\n';
    const report = run(src(html), src(md), opts);
    assert.equal(report.summary.exitCode, 1);
    assert.deepEqual(report.findings.map((f) => f.code).sort(), ['LINK_ADDED', 'LINK_MISSING', 'TEXT_CHANGED']);
    const out = `${renderText(report)}${renderJson(report)}`;
    assert.ok(!out.includes('pass@') && !out.includes('pa ss'), 'the credential is shown');
  });
});
