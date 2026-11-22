// Regression tests for release 0.2.41: a link target written with a special scheme whose colon is not followed by two
// slashes, as in https:/user:secret@host.example/x. Against a base of the same scheme the URL parser reads it as a
// relative path, so the user information ended up in the path of the resolved target, where maskHref found nothing to
// remove, and the report printed it as the "after" value (P3-1, an outside fuzz run of 0.2.40 on 2026-11-22).
// The tests that name a secret fail on 0.2.40. A test whose name ends in "(control)" pins a target that must be shown as
// before. The secret is a made-up canary value, no real credential.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { movedUserinfoMask } from '../src/normalize.js';
import { renderJson, renderText } from '../src/report.js';
import { run, type RunOptions, type SourceInput } from '../src/run.js';
import { CLI } from './helpers.js';

const opts: RunOptions = { strict: false, mode: 'offline' };
const src = (body: string, base = 'https://example.com/page'): SourceInput => ({ meta: { kind: 'file', bytes: body.length }, body, base });

const SECRET = 'CANARYPWD7f3a';
const QUADS: string[] = [];
for (let i = 0; i + 4 <= SECRET.length; i++) QUADS.push(SECRET.slice(i, i + 4));
const leaked = (out: string): string | null => QUADS.find((q) => out.includes(q)) ?? null;
const BS = String.fromCharCode(92);

const HTML = '<html><body><main><p>Read <a href="https://example.com/docs">the docs</a> now.</p></main></body></html>';
const md = (target: string) => `Read [the docs](<${target}>) now.\n`;
const report = (html: string, markdown: string, base?: string) => {
  const r = run(src(html, base), src(markdown, base), opts);
  return { r, out: `${renderText(r)}\n${renderJson(r)}` };
};
const changed = (r: ReturnType<typeof run>) => r.findings.find((f) => f.code === 'LINK_TARGET_CHANGED');

describe('P3-1: user information that the parser moves into the path is not shown', () => {
  const written = [
    `https:/user:${SECRET}@example.com/x`,
    `https:user:${SECRET}@example.com/x`,
    `https:x//user:${SECRET}@example.com/x`,
    `HTTPS:/user:${SECRET}@example.com/x`,
    `https:${BS}user:${SECRET}@example.com/x`,
    `https:/user:${SECRET}@example.com/x?q=1#f`,
    `http:/user:${SECRET}@example.com/x`,
    // Found by the independent check before release: a # or ? inside the password, and a backslash in the user name of
    // an authority, which the parser reads as the end of the host.
    `https:/u:${SECRET}#x@example.com/x`,
    `https:/u:${SECRET}?x@example.com/x`,
    `https://CORP${BS}e:${SECRET}@example.com/x`,
    `https:/${BS}CORP${BS}e:${SECRET}@example.com/x`,
    `https:${BS}${BS}CORP${BS}e:${SECRET}@example.com/x`,
    // Found by the second independent check: a /, ? or # inside the password after a backslash user name.
    `https://CORP${BS}e:${SECRET}/ZZZ@example.com/x`,
    `https://CORP${BS}e:${SECRET}?x@example.com/x`,
    `https://CORP${BS}e:${SECRET}#x@example.com/x`,
    // Found by the third independent check: a ? or # inside the password of an authority. The password starts with a
    // digit, so the parser reads a host and a port and the target resolves; the unit test below covers "user:x?".
    `https://user:1?${SECRET}@example.com/x`,
    `https://user:1#${SECRET}@example.com/x`,
  ];
  for (const target of written) {
    it(`the Markdown target ${JSON.stringify(target)} shows only its scheme in both formats`, () => {
      const { r, out } = report(HTML, md(target));
      assert.equal(leaked(out), null, out);
      const f = changed(r);
      assert.ok(f, 'a target change is reported');
      // The finding holds the scheme and "//***"; the report boundary (redactText) writes it as "https://***/".
      assert.match(String(f.after), /^https?:\/\/\*\*\*$/);
      assert.ok(out.includes('https://***/') || out.includes('http://***/'), out);
    });
    it(`the HTML target ${JSON.stringify(target)} shows only its scheme in both formats`, () => {
      const html = HTML.replace('https://example.com/docs', target);
      const { out } = report(html, md('https://example.com/docs'));
      assert.equal(leaked(out), null, out);
    });
  }

  // Found by the third and fourth independent checks: shapes outside the special schemes, an authority the parser
  // refuses, a file: URL and a leading Unicode space or NUL. Each must show no part of the secret in either format,
  // whatever finding it gives.
  const wider = [
    `gopher:user:${SECRET}@example.com`,
    `my_app:user:${SECRET}@example.com`,
    `user_name:${SECRET}@example.com`,
    `//user:x?${SECRET}@example.com/x`,
    `gopher://user:x?${SECRET}@example.com/x`,
    `https://user:pa/ss?${SECRET}@example.com/x`,
    `file:///user:${SECRET}@example.com`,
    `${String.fromCharCode(0xa0)}https:/user:${SECRET}@example.com/x`,
    `${String.fromCharCode(0x2003)}https:/user:${SECRET}@example.com/x`,
    `${String.fromCharCode(0x3000)}https:/user:${SECRET}@example.com/x`,
    // Found by the fifth independent check.
    `gopher:///user:${SECRET}@example.com`,
    `u:///user:${SECRET}@example.com`,
    `gopher:/u v:${SECRET}@example.com:8080/p`,
    `ht tps:/user:${SECRET}@example.com/x`,
    `ht tps://user:${SECRET}@example.com/x`,
    `${String.fromCharCode(0x2003)}user:${SECRET}@example.com/p`,
    `${String.fromCharCode(0x200b)}https:///user:${SECRET}@example.com`,
    `u?x:${SECRET}@example.com`,
  ];
  for (const target of wider) {
    it(`the target ${JSON.stringify(target)} shows no part of the secret on either side`, () => {
      assert.equal(leaked(report(HTML, md(target)).out), null, target);
      assert.equal(leaked(report(HTML.replace('https://example.com/docs', target), md('https://example.com/docs')).out), null, target);
    });
  }
  it('a Markdown target that starts with a NUL character shows no part of the secret', () => {
    const { out } = report(HTML, md(`${String.fromCharCode(0)}https:/user:${SECRET}@example.com/x`));
    assert.equal(leaked(out), null, out);
  });

  it('the base of an http page reads an http: target the same way', () => {
    const { out } = report(HTML, md(`http:/user:${SECRET}@example.com/x`), 'http://example.com/page');
    assert.equal(leaked(out), null, out);
  });

  it('the command line on local files prints the scheme alone as the after value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-p31-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.html'), HTML);
      fs.writeFileSync(path.join(dir, 'a.md'), md(`https:/user:${SECRET}@example.com/x`));
      const res = spawnSync(process.execPath, [CLI, '--html-file', path.join(dir, 'a.html'), '--markdown-file', path.join(dir, 'a.md'), '--base-url', 'https://example.com/p', '--format', 'text'], { encoding: 'utf8' });
      assert.equal(res.status, 1, res.stderr);
      assert.equal(leaked(res.stdout + res.stderr), null, res.stdout);
      assert.match(res.stdout, /after: {2}https:\/\/\*\*\*\//);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('movedUserinfoMask reads the written target alone', () => {
  it('masks a special scheme with no or one slash and an @ before the query', () => {
    assert.equal(movedUserinfoMask(`https:/user:${SECRET}@example.com/x`), 'https://***');
    assert.equal(movedUserinfoMask(`HTTPS:user:${SECRET}@example.com/x`), 'https://***');
    assert.equal(movedUserinfoMask(`ftp:/user:${SECRET}@example.com/x`), 'ftp://***');
    assert.equal(movedUserinfoMask(`  https:/user:${SECRET}@example.com/x`), 'https://***');
    assert.equal(movedUserinfoMask(`ht\ttps:/user:${SECRET}@example.com/x`), 'https://***');
    assert.equal(movedUserinfoMask(`https:/user:pa#${SECRET}@example.com/x`), 'https://***');
    assert.equal(movedUserinfoMask('https:/docs/x?mail=a@b.com'), 'https://***');
    assert.equal(movedUserinfoMask(`https://CORP${BS}erik:${SECRET}@example.com/x`), 'https://***');
    assert.equal(movedUserinfoMask(`https:///CORP${BS}erik:${SECRET}@example.com/x`), 'https://***');
    assert.equal(movedUserinfoMask(`https://user:x?${SECRET}@example.com/x`), 'https://***');
    assert.equal(movedUserinfoMask('https://example.com?e=a@b.com'), 'https://***');
  });
  it('leaves every other target to maskHref (control)', () => {
    for (const t of [
      `https://user:${SECRET}@example.com/x`,
      `https:${BS}${BS}user:${SECRET}@example.com/x`,
      `https:///user:${SECRET}@example.com/x`,
      'https:/docs/x',
      'https://example.com/a@b/x',
      'https://example.com/docs' + BS + 'a@b',
      'https://example.com/?e=a@b.com',
      'https://example.com/@team/x',
      'https://localhost:8080/@team',
      'mailto:jane@example.com',
      `user:${SECRET}@example.com/x`,
      '/x@2x.png',
      'docs/@name',
    ]) assert.equal(movedUserinfoMask(t), null, t);
  });
  it('ordinary targets with an @ keep their reading (control)', () => {
    for (const t of ['https://localhost:8080/@team', 'mailto:jane@example.com', '/docs/a@2x.png', 'https://example.com/?e=a@b.com', 'gopher://user@example.com/x', `user:${SECRET}@example.com/x`]) {
      assert.equal(movedUserinfoMask(t), null, t);
    }
    assert.equal(movedUserinfoMask(`gopher:user:${SECRET}@example.com`), 'gopher:***');
    assert.equal(movedUserinfoMask(`user_name:${SECRET}@example.com`), '***');
    assert.equal(movedUserinfoMask(`file:///user:${SECRET}@example.com`), 'file://***');
    assert.equal(movedUserinfoMask(`https://user:pa/ss?${SECRET}@example.com/x`), 'https://***');
    assert.equal(movedUserinfoMask(`//user:x?${SECRET}@example.com/x`), '//***');
  });
  it('an ordinary target with an @ in its path is shown as before (control)', () => {
    const { r } = report(HTML, md('https://example.com/@team/x'));
    assert.equal(changed(r)?.after, 'https://example.com/@team/x');
  });
  it('a target with user information after two slashes is still masked by the parser (control)', () => {
    const { r, out } = report(HTML, md(`https://user:${SECRET}@example.com/x`));
    assert.equal(leaked(out), null, out);
    assert.equal(changed(r)?.after, 'https://example.com/x');
  });
});
