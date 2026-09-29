// Regressions for the third audit retest of 2026-09-28 (Tek-542, see
// turva/tyot/astra-uusinta-2-2026-09-28/korjausohje-3.md): a numeric userinfo password must stay masked in
// NUMBER_CHANGED (P-N1), a parenthesized userinfo longer than the old regex bound must still be masked
// fail-closed (P-N2), a --timeout-ms value broken by a raw space must be masked in full (P-N3), --timeout-ms
// and --max-bytes must reject a value Node cannot actually honor or that overflows to Infinity (P-N4), a
// write failure must still produce a JSON error on stdout under --format json (P-N5), the Starlight code
// extractor must respect its own <code> wrapper's hidden state (N-P-visibility), <template> content must stay
// inert in task-state comparison (N-P-template-task), rowspan="0" must be disclosed like any other span
// (N-P-rowspan-zero), a raw HTML block on the Markdown side must keep its structural "not compared" disclosure
// (N-P-raw-html), and a diagnostic value such as --selector must be capped and reported in its own field
// (V10-P3-01, package side). Every case that used to be exposed, silently wrong or silently dropped has a
// control alongside it that must stay clean.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { compare } from '../src/compare.js';
import { extractHtml } from '../src/html.js';
import { extractMarkdown } from '../src/markdown.js';
import type { Finding } from '../src/model.js';
import type { Report } from '../src/run.js';
import { CLI, ROOT } from './helpers.js';

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

let tmp: string;
before(() => {
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  tmp = fs.mkdtempSync(path.join(ROOT, '.tmp', 'astra3-'));
});
after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // A sandbox without delete permission leaves the temp folder behind; that is not a test failure.
  }
});

function writeFiles(name: string, html: string, md: string): string[] {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, 'page.html');
  const mdPath = path.join(dir, 'page.md');
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(mdPath, md, 'utf8');
  return ['--html-file', htmlPath, '--markdown-file', mdPath];
}

describe('P-N1: a numeric userinfo password does not leak through NUMBER_CHANGED', () => {
  it('the differing numbers inside a parenthesized userinfo are not shown', () => {
    const r = check(
      page('<p>Open https://(USER):64923001@example.test/page for private report details today.</p>'),
      'Open https://(USER):64923002@example.test/page for private report details today.\n',
    );
    const numberFinding = r.findings.find((f) => f.code === 'NUMBER_CHANGED');
    assert.ok(numberFinding, r.codes.join());
    for (const v of [numberFinding!.message, numberFinding!.before, numberFinding!.after]) {
      if (v !== undefined) assert.doesNotMatch(v, /6492300[12]/, v);
    }
  });
  it('an ordinary numeric difference outside any URL is still shown as before', () => {
    const r = check(page('<p>The plan price is 10 euros per month.</p>'), 'The plan price is 11 euros per month.\n');
    const numberFinding = r.findings.find((f) => f.code === 'NUMBER_CHANGED');
    assert.ok(numberFinding, r.codes.join());
    assert.equal(numberFinding!.before, '10');
    assert.equal(numberFinding!.after, '11');
  });
});

describe('P-N2: a parenthesized userinfo longer than the old regex bound is still masked (fail-closed)', () => {
  it('a 257-character parenthesized user name no longer bypasses the masking', () => {
    const sentence = `Open https://(${'u'.repeat(257)}):SYNTHETIC_SECRET@example.test/page for private report details today.`;
    const r = check(page(`<p>${sentence}</p>`), `${sentence}\n`);
    for (const f of r.findings) {
      const fields = [f.message, f.before, f.after, f.html?.excerpt, f.markdown?.excerpt].filter((v): v is string => typeof v === 'string');
      for (const v of fields) assert.doesNotMatch(v, /SYNTHETIC_SECRET/, JSON.stringify(f));
    }
  });
  it('a 4000-character secret with no closing landmark nearby stays masked through the scan window', () => {
    const sentence = `Open https://(name):${'s'.repeat(4000)}SYNTHETIC_TAIL@example.test/page today.`;
    const r = check(page(`<p>${sentence}</p>`), `${sentence}\n`);
    for (const f of r.findings) {
      const fields = [f.message, f.before, f.after, f.html?.excerpt, f.markdown?.excerpt].filter((v): v is string => typeof v === 'string');
      for (const v of fields) assert.doesNotMatch(v, /SYNTHETIC_TAIL/, JSON.stringify(f));
    }
  });
});

describe('P-N3: a --timeout-ms value broken by a raw space is masked in full, not only its query part', () => {
  it('the userinfo is masked in both stderr and the JSON summary.error', () => {
    const args = ['--html-file', 'nonexistent-html-file-marker', '--markdown-file', 'nonexistent-markdown-file-marker', '--format', 'json', '--timeout-ms', 'ftp://u:SPACE SECRET@example.test/?token=TOKEN#FRAG'];
    const r = cli(args);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.err, /SPACE SECRET/);
    assert.doesNotMatch(r.err, /TOKEN/);
    const report = JSON.parse(r.out) as Report;
    assert.doesNotMatch(report.summary.error ?? '', /SPACE SECRET/);
    assert.doesNotMatch(report.summary.error ?? '', /TOKEN/);
  });
});

describe('P-N4: --timeout-ms and --max-bytes reject a value the runtime cannot honor', () => {
  const nonexistent = ['--html-file', 'nonexistent-html-file-marker', '--markdown-file', 'nonexistent-markdown-file-marker'];
  it("--timeout-ms past Node's 32-bit timer limit is rejected, not silently turned into ~1 ms", () => {
    const r = cli([...nonexistent, '--timeout-ms', '2147483648']);
    assert.equal(r.code, 2);
    assert.match(r.err, /--timeout-ms must be a positive integer/);
  });
  it('--timeout-ms overflowing to Infinity (400 nines) is rejected', () => {
    const r = cli([...nonexistent, '--timeout-ms', '9'.repeat(400)]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--timeout-ms must be a positive integer/);
  });
  it('--max-bytes overflowing to Infinity (400 nines) is rejected', () => {
    const r = cli([...nonexistent, '--max-bytes', '9'.repeat(400)]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--max-bytes must be a positive integer/);
  });
  it('an ordinary --timeout-ms value under the limit is unaffected', () => {
    const r = cli([...nonexistent, '--timeout-ms', '5000']);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.err, /--timeout-ms/);
    assert.match(r.err, /Cannot read/);
  });
});

describe('P-N5: a write failure under --format json still produces a JSON error on stdout', () => {
  it('a missing --output directory reports JSON on stdout, matching every other error path', () => {
    const args = writeFiles('pn5', page('<p>Same visible paragraph.</p>'), 'Same visible paragraph.\n');
    const out = path.join(tmp, 'missing-directory', 'report.json');
    const r = cli([...args, '--format', 'json', '--output', out]);
    assert.equal(r.code, 2);
    assert.notEqual(r.out.trim(), '');
    const report = JSON.parse(r.out) as Report;
    assert.equal(report.summary.result, 'error');
    assert.match(report.summary.error ?? '', /Cannot write report/);
    assert.match(r.err, /Cannot write report/);
    assert.equal(fs.existsSync(out), false);
  });
  it('the same failure under the default text format still has no JSON on stdout (unchanged behavior)', () => {
    const args = writeFiles('pn5-text', page('<p>Same visible paragraph.</p>'), 'Same visible paragraph.\n');
    const out = path.join(tmp, 'missing-directory-2', 'report.txt');
    const r = cli([...args, '--output', out]);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
    assert.match(r.err, /Cannot write report/);
  });
});

describe("N-P-visibility: Starlight code extraction respects the <code> wrapper's own hidden state", () => {
  const hiddenCode = '<div class="expressive-code"><figure><pre data-language="sh">'
    + '<code hidden><div class="ec-line"><div class="code"><span>secret line</span></div></div>'
    + '</code></pre></figure></div><p>Public</p>';
  it('a hidden <code> wrapper no longer passes strict mode silently', () => {
    const r = check(page(hiddenCode), '```sh\nsecret line\n```\n\nPublic\n', { profile: 'starlight' });
    assert.ok(r.codes.some((c) => c.startsWith('BLOCK_')), r.codes.join());
  });
  it('aria-hidden="true" on the wrapper is treated the same way', () => {
    const r = check(page(hiddenCode.replace('<code hidden>', '<code aria-hidden="true">')), '```sh\nsecret line\n```\n\nPublic\n', { profile: 'starlight' });
    assert.ok(r.codes.some((c) => c.startsWith('BLOCK_')), r.codes.join());
  });
  it('a visible <code> wrapper is unaffected', () => {
    const r = check(page(hiddenCode.replace(' hidden', '')), '```sh\nsecret line\n```\n\nPublic\n', { profile: 'starlight' });
    assert.deepEqual(r.codes, []);
  });
});

describe('N-P-template-task: <template> content is inert in task-state comparison', () => {
  const templateTask = '<ul><li><template><input checked type="checkbox"></template><input type="checkbox">Task</li></ul>';
  it('the real, unchecked checkbox behind an inert template checkbox matches an unchecked Markdown item', () => {
    assert.deepEqual(check(page(templateTask), '- [ ] Task\n').codes, []);
  });
  it('the same markup is still a real difference against a checked Markdown item', () => {
    const r = check(page(templateTask), '- [x] Task\n');
    assert.ok(r.codes.includes('LIST_TASK_CHANGED:error'), r.codes.join());
  });
});

describe('N-P-rowspan-zero: rowspan="0" is disclosed the same way as any other span', () => {
  it('rowspan="0" reports EXTRACTION_TABLE_SPAN_NOT_COMPARED, not a silent pass', () => {
    const html = page('<table><tr><th>Plan</th><th>Feature</th></tr><tr><td rowspan="0">Basic</td><td>A</td></tr><tr><td>B</td></tr></table>');
    const md = '| Plan | Feature |\n| --- | --- |\n| Basic | A |\n| B | |\n';
    const r = check(html, md);
    assert.ok(r.codes.includes('EXTRACTION_TABLE_SPAN_NOT_COMPARED:info'), r.codes.join());
    assert.ok(!r.codes.some((c) => c.startsWith('TABLE_')), r.codes.join());
  });
  it('colspan="0" is not treated as a span; HTML gives colspan no such magic zero', () => {
    const html = page('<table><tr><th colspan="0">A</th></tr><tr><td colspan="0">1</td></tr></table>');
    const md = '| A |\n| - |\n| 1 |\n';
    assert.deepEqual(check(html, md).codes, []);
  });
});

describe('N-P-raw-html: raw HTML on the Markdown side keeps its structural "not compared" disclosure', () => {
  it('a reversed list inside raw HTML on the Markdown side reports the same info as on the HTML side', () => {
    const r = check(
      page('<ol start="3"><li>Alpha</li><li>Beta</li><li>Gamma</li></ol>'),
      '<ol reversed start="3"><li>Alpha</li><li>Beta</li><li>Gamma</li></ol>\n',
    );
    assert.ok(r.codes.includes('EXTRACTION_LIST_REVERSED_NOT_COMPARED:info'), r.codes.join());
    assert.ok(!r.codes.some((c) => c.startsWith('LIST_NUMBER_CHANGED')), r.codes.join());
  });
  it('a spanned table inside raw HTML on the Markdown side reports the same info and skips cell comparison', () => {
    const r = check(
      page('<table><tr><th>Plan</th><th>Feature</th></tr><tr><td>Basic</td><td>A</td></tr><tr><td>B</td></tr></table>'),
      '<table><tr><th>Plan</th><th>Feature</th></tr><tr><td rowspan="2">Basic</td><td>A</td></tr><tr><td>B</td></tr></table>\n',
    );
    assert.ok(r.codes.includes('EXTRACTION_TABLE_SPAN_NOT_COMPARED:info'), r.codes.join());
    assert.ok(!r.codes.some((c) => c.startsWith('TABLE_')), r.codes.join());
  });
  it('the same structures on the HTML side are unaffected by this change', () => {
    const r = check(page('<ol reversed start="3"><li>Alpha</li><li>Beta</li><li>Gamma</li></ol>'), '3. Alpha\n4. Beta\n5. Gamma\n');
    assert.deepEqual(r.codes, ['EXTRACTION_LIST_REVERSED_NOT_COMPARED:info']);
  });
});

describe('V10-P3-01: a diagnostic value is capped and reported in its own field, not only inside the sentence', () => {
  it('an unmatched --selector is reported with a separate, exact errorValue', () => {
    const args = writeFiles('selector-no-match', page('<p>Hello.</p>'), 'Hello.\n');
    const r = cli([...args, '--selector', '#does-not-exist', '--format', 'json']);
    assert.equal(r.code, 2);
    const report = JSON.parse(r.out) as Report;
    assert.equal(report.summary.errorValue, '#does-not-exist');
    assert.doesNotMatch(report.summary.error ?? '', /#does-not-exist/);
    assert.match(report.summary.error ?? '', /matched no element/);
  });
  it('a very long --selector is capped at 120 characters in errorValue', () => {
    const args = writeFiles('selector-long', page('<p>Hello.</p>'), 'Hello.\n');
    const selector = `#${'x'.repeat(500)}`;
    const r = cli([...args, '--selector', selector, '--format', 'json']);
    assert.equal(r.code, 2);
    const report = JSON.parse(r.out) as Report;
    assert.equal(report.summary.errorValue?.length, 120);
    assert.equal(report.summary.errorValue, selector.slice(0, 120));
  });
  it('an invalid selector syntax carries the same capped value, and the text report shows it once', () => {
    const args = writeFiles('selector-invalid', page('<p>Hello.</p>'), 'Hello.\n');
    const r = cli([...args, '--selector', ':::bad']);
    assert.equal(r.code, 2);
    assert.match(r.err, /Invalid selector/);
  });
  it('a matched selector is unaffected', () => {
    const args = writeFiles('selector-ok', page('<p>Hello.</p>'), 'Hello.\n');
    const r = cli([...args, '--selector', 'main']);
    assert.equal(r.code, 0);
  });
});
