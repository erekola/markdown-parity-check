// Regression tests for the second independent check of release 0.2.43 (QA-2, 2026-11-23). D1: a password of digits
// only inside a moved-user-information form reached the NUMBER_CHANGED message and its before and after values, where
// the README says the values of a masked part are left out. D5: a tab right after the colon of the user information of
// a network-path reference was shown whole. D2: the word in front of a masked colon was shown in lower case. The
// secret is a made-up canary, no real credential.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactText } from '../src/normalize.js';
import { renderJson, renderText } from '../src/report.js';
import { run, type SourceInput } from '../src/run.js';

const BS = String.fromCharCode(92);
const BASE = 'https://example.com/dir/page';
const source = (file: string, body: string): SourceInput => ({
  meta: { kind: 'file', file, bytes: body.length, baseUrl: BASE },
  body,
  base: BASE,
});

describe('D1: a numeric password in a moved or bare user information form is left out of NUMBER_CHANGED', () => {
  const forms = [
    'See user:%s#x@host.example/p end',
    `See https://CORP${BS}erik:%s@host.example/x end`,
    `See DOMAIN${BS}erik:%s@host.example/p end`,
    'See :%s@host.example/x end',
    'See user:%s?x@host.example/p end',
    `See ftp://corp.example${BS}erik:%s@example.com/ end`,
    'See foo:%s@bar.example/x end',
    'See user:%s@host.example/p end',
    'See https://erik@corp:%s#x@host/ end',
    'See https://user:%s@host.example/p end',
    'See //user:%s@host.example/p end',
  ];
  const A = '7391845';
  const B = '5481937';
  for (const form of forms) {
    it(`hides both numbers: ${form}`, () => {
      const h = form.replace('%s', A);
      const m = form.replace('%s', B);
      const r = run(source('a.html', `<main><p>${h}</p></main>`), source('a.md', `${m}\n`), { mode: 'offline', strict: false });
      const codes = r.findings.map((f) => f.code);
      assert.ok(codes.includes('NUMBER_CHANGED') || codes.includes('TEXT_CHANGED'), codes.join());
      const out = renderJson(r) + renderText(r);
      assert.ok(!out.includes(A) && !out.includes(B), out);
    });
  }
  it('still shows the numbers of ordinary text (control)', () => {
    const r = run(source('a.html', '<main><p>We sold 7391845 units.</p></main>'), source('a.md', 'We sold 5481937 units.\n'), { mode: 'offline', strict: false });
    const f = r.findings.find((x) => x.code === 'NUMBER_CHANGED');
    assert.ok(f !== undefined && f.before === '7391845' && f.after === '5481937');
  });
  it('still shows the numbers around a masked part (control)', () => {
    const r = run(source('a.html', '<main><p>Call 111 or user:CANARYPWD@host.example/p now.</p></main>'), source('a.md', 'Call 222 or user:CANARYPWD@host.example/p now.\n'), { mode: 'offline', strict: false });
    const f = r.findings.find((x) => x.code === 'NUMBER_CHANGED');
    assert.ok(f !== undefined && f.before === '111' && f.after === '222', JSON.stringify(f));
  });
});

describe('D5: a tab right after the colon of a network-path reference', () => {
  it('masks the password', () => {
    for (const t of ['//user:\tPWXQ7@host.example/p', 'see //user:\tPWXQ7@host.example/p now', 'https://user:\tPWXQ7@host.example/p']) {
      assert.ok(!redactText(t).includes('PWXQ7'), `${JSON.stringify(t)} -> ${redactText(t)}`);
    }
  });
  it('masks it in the text of a block, where the page has turned the tab into a space', () => {
    const r = run(source('a.html', '<main><p>See //user:\tPWXQ7@host.example/p now</p></main>'), source('a.md', 'See it\n'), { mode: 'offline', strict: false });
    const out = renderJson(r) + renderText(r);
    assert.ok(!out.includes('PWXQ7'), out);
  });
  it('shows a plain space right after the colon as before (control)', () => {
    assert.ok(redactText('//user: PWXQ7@host.example/p').includes('PWXQ7'));
  });
});

describe('D2: the word in front of a masked colon keeps its case', () => {
  it('Re:Re:@work', () => assert.equal(redactText('Re:Re:@work'), 'Re:***'));
  it('Std::vector@x', () => assert.equal(redactText('use Std::vector@x ok'), 'use Std:*** ok'));
});

describe('N1: a tab right after the colon of a scheme-less user:password@host form', () => {
  const U3000 = String.fromCharCode(0x3000);
  it('masks a letter and a digit password', () => {
    for (const pw of ['PWXQ7', '7742']) {
      for (const t of [`See user:\t${pw}@host.example/p end`, `user:\t${pw}@host.example/p?x=1`, `See DOMAIN${BS}erik:\t${pw}@host.example/p end`]) {
        const out = redactText(t);
        assert.ok(!out.includes(pw), `${JSON.stringify(t)} -> ${JSON.stringify(out)}`);
      }
    }
  });
  it('masks it in a report message and a link target', () => {
    const r = run(source('a.html', '<main><p><a href="user:%09PWXQ7@host.example/p">x</a> and 5</p></main>'), source('a.md', 'See it and 6\n'), { mode: 'offline', strict: false });
    const out = renderJson(r) + renderText(r);
    assert.ok(!out.includes('PWXQ7'), out);
  });
  it('keeps a plain space and an ideographic space after the colon shown (documented)', () => {
    assert.ok(redactText('See user: PWXQ7@host.example/p end').includes('PWXQ7'));
    assert.ok(redactText(`See user:${U3000}PWXQ7@host.example/p end`).includes('PWXQ7'));
  });
  it('does not change a tab after a colon without user information', () => {
    for (const t of ['Note:\tcall me', 'Note:\tjane@example.com', 'a:\tb c@d']) assert.equal(redactText(t), t);
  });
});
