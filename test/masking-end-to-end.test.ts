// End-to-end tests of the credential masking in a report. The masking is a display safeguard, and two things must
// hold: every shape the CHANGELOG says is masked is masked in every output of the real pipeline, and the masking does
// not hide ordinary content that carries no credential. The tests go through run(), both renderers and the command
// line, not through redactText on a raw string, because the text of a block has been normalized (white space
// collapsed) and the links of the Markdown have been extracted before the report is written.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.js';
import { dropAuthorityControls, hideUrlSecrets, insideUserinfoSpan, maskAuthorityUserinfo, redactText, strictNormalize, userinfoSpansOf } from '../src/normalize.js';
import { renderJson, renderText } from '../src/report.js';
import { run, type RunOptions, type SourceInput } from '../src/run.js';
import { CLI } from './helpers.js';

const opts: RunOptions = { strict: false, mode: 'offline' };
const src = (body: string): SourceInput => ({ meta: { kind: 'file', bytes: body.length }, body, base: 'https://example.com/page' });

const SECRET = 'QzXv7Kp9Wm';
const HEAD = SECRET.slice(0, 5);
const TAIL = SECRET.slice(5);
const QUADS: string[] = [];
for (let i = 0; i + 4 <= SECRET.length; i++) QUADS.push(SECRET.slice(i, i + 4));

const WS = {
  TAB: String.fromCodePoint(0x09),
  LF: String.fromCodePoint(0x0a),
  VT: String.fromCodePoint(0x0b),
  FF: String.fromCodePoint(0x0c),
  CR: String.fromCodePoint(0x0d),
  LS: String.fromCodePoint(0x2028),
  PS: String.fromCodePoint(0x2029),
  NBSP: String.fromCodePoint(0xa0),
} as const;
type WsName = keyof typeof WS;
const ALL: WsName[] = ['TAB', 'LF', 'VT', 'FF', 'CR', 'LS', 'PS', 'NBSP'];
const NO_LINE_BREAK: WsName[] = ['TAB', 'VT', 'FF', 'LS', 'PS'];

/** Both report formats of one run, as one string. */
function reports(html: string, markdown: string): string {
  const r = run(src(html), src(markdown), opts);
  return `${renderText(r)}\n${renderJson(r)}`;
}

function leaked(out: string): string | null {
  return QUADS.find((q) => out.includes(q)) ?? null;
}

/** An HTML and a Markdown rendering of the same sentence that differ, so that a finding quotes the text. */
const positions: Record<string, (u: string) => [string, string]> = {
  text: (u) => [`<main><p>see ${u} now</p></main>`, `see ${u} later\n`],
  code: (u) => [`<main><p>run <code>${u}</code> now</p></main>`, 'run `' + u + '` later\n'],
  codeBlock: (u) => [`<main><pre><code>${u} one</code></pre></main>`, '```\n' + u + ' two\n```\n'],
  cell: (u) => [`<main><table><tr><th>a</th></tr><tr><td>${u}</td></tr></table></main>`, `| a |\n|---|\n| ${u} x |\n`],
  heading: (u) => [`<main><h2>see ${u} now</h2></main>`, `## see ${u} later\n`],
  listItem: (u) => [`<main><ul><li>see ${u} now</li></ul></main>`, `- see ${u} later\n`],
  imageAlt: (u) => [`<main><p><img src="a.png" alt="see ${u} now"></p></main>`, `![see ${u} later](a.png)\n`],
  htmlOnly: (u) => [`<main><p>see ${u} now</p><p>other</p></main>`, 'other\n'],
  markdownOnly: (u) => [`<main><p>other</p></main>`, `other\n\nsee ${u} later\n`],
  sameOnBothSides: (u) => [`<main><p>see ${u} now</p></main>`, `see ${u} now\n\nextra\n`],
};

/** A heading and a table cell end at a line break in the Markdown source, so a break cannot sit inside them there. */
const lineBreakFits = (position: string, ws: WsName): boolean => !((ws === 'LF' || ws === 'CR') && (position === 'heading' || position === 'cell'));

const shapes: Array<[string, (w: WsName) => string, WsName[]]> = [
  ['white space inside the password', (w) => `https://usr:${HEAD}${WS[w]}${TAIL}@h.example/p`, ALL],
  ['white space right after the colon', (w) => `https://usr:${WS[w]}${SECRET}@h.example/p`, ['TAB', 'LF', 'VT', 'FF', 'CR', 'LS', 'PS']],
  ['white space before the at sign', (w) => `https://usr:${SECRET}${WS[w]}@h.example/p`, ALL],
  ['white space inside the user name, a password after it', (w) => `https://${HEAD}${WS[w]}${TAIL}:pw@h.example/p`, ALL],
  ['white space inside a user name without a password', (w) => `https://${HEAD}${WS[w]}${TAIL}@h.example/p`, NO_LINE_BREAK],
];

describe('a credential with white space inside it reaches no report, in any position', () => {
  for (const [name, make, list] of shapes) {
    for (const [position, place] of Object.entries(positions)) {
      it(`${name}, ${position}`, () => {
        const failures: string[] = [];
        for (const w of list) {
          if (!lineBreakFits(position, w)) continue;
          const [html, markdown] = place(make(w));
          const out = reports(html, markdown);
          const q = leaked(out);
          if (q !== null) failures.push(`${w}: ${q}`);
        }
        assert.deepEqual(failures, []);
      });
    }
  }

  it('the autolinks of the Markdown do not carry the head or the tail of a credential (white space inside the password)', () => {
    for (const w of ALL) {
      const u = `https://usr:${HEAD}${WS[w]}${TAIL}@h.example/p`;
      const out = reports(`<main><p>see ${u} now</p></main>`, `see ${u} later\n`);
      assert.equal(leaked(out), null, `${w}`);
      assert.ok(!/LINK_ADDED[^\n]*(?:usr:|Kp9Wm|mailto)/.test(out), `${w}: a link object shows part of the credential`);
    }
  });

  it('a character reference for a tab, a vertical tab or a form feed after the colon is masked', () => {
    for (const ref of ['&#9;', '&#x09;', '&#11;', '&#x0b;', '&#12;', '&#10;', '&#13;']) {
      const out = reports(`<main><p>see https://usr:${ref}${SECRET}@h.example/p now</p></main>`, 'other\n');
      assert.equal(leaked(out), null, ref);
    }
  });
});

describe('a credential is still shown as a host, a path and the rest of the sentence', () => {
  it('the host and the path of a masked URL stay visible', () => {
    const out = reports(`<main><p>see https://usr:${WS.TAB}${SECRET}@h.example/p now</p></main>`, 'other\n');
    assert.match(out, /see https:\/\/h\.example\/p now/);
  });
});

describe('ordinary content is not hidden by the masking', () => {
  /** The two sentences differ in one value; the report must show both values. */
  function showsBoth(template: (v: string) => string, a: string, b: string): void {
    const out = reports(`<main><p>${template(a)}</p></main>`, `${template(b)}\n`);
    assert.ok(out.includes(a), `${template(a)}: the value ${a} is hidden`);
    assert.ok(out.includes(b), `${template(b)}: the value ${b} is hidden`);
  }

  it('an anchor of a bare host with a path is shown', () => {
    showsBoth((v) => `See example.com/docs/guide#step-${v} for the details.`, '3', '4');
    showsBoth((v) => `See github.com/org/repo/blob/main/src/a.ts#L${v} for it.`, '10', '20');
    showsBoth((v) => `See github.com/org/repo/blob/main/src/a.ts#L${v}-L40.`, '10', '20');
    showsBoth((v) => `Run curl example.com/api/items#row-${v} now.`, '1', '2');
    showsBoth((v) => `Hit 127.0.0.1/health#${v} for liveness.`, '1', '2');
    showsBoth((v) => `Edit README.md/CHANGELOG.md#entry-${v} now.`, '1', '2');
    showsBoth((v) => `See example.com/docs/guide#section-${v}ab for the details.`, 'x', 'y');
  });

  it('a bare host with a path and a fragment or a query that holds a value is still masked (control)', () => {
    for (const u of [`example.com/cb#access_token=${SECRET}`, `192.168.0.1/cb#t=${SECRET}`, `example.com#t=${SECRET}`, `localhost:8080/cb#t=${SECRET}`, `example.com/cb?t=${SECRET}`, `example.com/cb?a=1#frag=${SECRET}`, `example.com/cb?flag#t=${SECRET}`, `example.com/app#tab=${SECRET}`]) {
      const out = reports(`<main><p>open ${u} now</p></main>`, `open ${u.replace(SECRET, 'zzzzzzzzzz')} now\n`);
      assert.equal(leaked(out), null, u);
    }
  });

  it('a query without a value on a bare host is shown as it is', () => {
    showsBoth((v) => `Open example.com/status?debug${v} now.`, 'on', 'off');
  });

  it('an address with a port and an e-mail address in the same sentence keep both', () => {
    for (const lead of ['Use', 'Call']) {
      const html = `<main><p>${lead} https://api.example.com:8443 or write to ops@example.org today.</p></main>`;
      const md = `${lead} https://api.example.com:8443 or write to sales@example.org today.\n`;
      const out = reports(html, md);
      assert.ok(out.includes('ops@example.org'), 'the first address is hidden');
      assert.ok(out.includes('sales@example.org'), 'the second address is hidden');
      assert.ok(out.includes('https://api.example.com:8443'), 'the address with its port is hidden');
    }
    showsBoth((v) => `Open http://localhost:3000 then email ${v}@example.org.`, 'dev', 'ops');
    showsBoth((v) => `https://example.com:443 uses TLS, ask ${v}@example.org about it.`, 'me', 'you');
  });

  it('white space after a port, of any kind, does not end up in the user information', () => {
    for (const w of ['TAB', 'LF', 'VT', 'FF', 'CR'] as WsName[]) {
      const out = reports(`<main><p>Use https://api.example.com:8443${WS[w]}ops@example.org today.</p></main>`, `Use https://api.example.com:8443${WS[w]}sales@example.org today.\n`);
      assert.ok(out.includes('ops@example.org') && out.includes('sales@example.org'), w);
    }
  });

  it('a line break between an address and an e-mail address is text, with or without a colon after a word', () => {
    const out = reports('<main><p>Contact:\nhttps://a.example\nops@b.example</p></main>', 'Contact:\nhttps://a.example\nsales@b.example\n');
    assert.ok(out.includes('ops@b.example') && out.includes('sales@b.example'));
  });

  it('a password of digits followed by a space is not masked, which is the price of showing a port (documented)', () => {
    const out = reports('<main><p>see https://usr:123 456@h.example/p now</p></main>', 'other\n');
    assert.ok(out.includes('456'));
  });
});

describe('command line: no argument adds a line to stdout or stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-e2e-'));
  const okHtml = path.join(dir, 'ok.html');
  const okMarkdown = path.join(dir, 'ok.md');
  fs.writeFileSync(okHtml, '<main><p>same</p></main>');
  fs.writeFileSync(okMarkdown, 'same\n');
  const breaks: Array<[string, string]> = [['LF', '\n'], ['CR', '\r'], ['CRLF', '\r\n']];
  const forms: Record<string, (v: string) => string[]> = {
    url: (v) => ['--url', v],
    'markdown-url': (v) => ['--url', 'https://ok.example/', '--markdown-url', v],
    'html-file': (v) => ['--html-file', v, '--markdown-file', okMarkdown],
    'markdown-file': (v) => ['--html-file', okHtml, '--markdown-file', v],
    'base-url': (v) => ['--html-file', okHtml, '--markdown-file', okMarkdown, '--base-url', v],
    selector: (v) => ['--html-file', okHtml, '--markdown-file', okMarkdown, '--selector', v],
    'front-matter': (v) => ['--html-file', okHtml, '--markdown-file', okMarkdown, '--front-matter', v],
    format: (v) => ['--html-file', okHtml, '--markdown-file', okMarkdown, '--format', v],
    'html-profile': (v) => ['--html-file', okHtml, '--markdown-file', okMarkdown, '--html-profile', v],
    'timeout-ms': (v) => ['--html-file', okHtml, '--markdown-file', okMarkdown, '--timeout-ms', v],
    'max-bytes': (v) => ['--html-file', okHtml, '--markdown-file', okMarkdown, '--max-bytes', v],
    output: (v) => ['--html-file', okHtml, '--markdown-file', okMarkdown, '--output', v],
    'unknown option name': (v) => [`--x${v}`],
    'positional argument': (v) => [v],
  };

  for (const [name, form] of Object.entries(forms)) {
    it(`${name}`, () => {
      const forged: string[] = [];
      for (const [bn, b] of breaks) {
        for (const format of [null, 'json']) {
          const value = `v${b}FORGED line`;
          const args = [...form(value), ...(format !== null && name !== 'format' ? ['--format', format] : [])];
          const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 20000 });
          for (const stream of [r.stdout, r.stderr]) {
            for (const line of stream.split(/\r\n|\r|\n/)) if (line.startsWith('FORGED')) forged.push(`${bn}/${format ?? 'text'}: ${line}`);
          }
        }
      }
      assert.deepEqual(forged, []);
    });
  }

  it('the path of a written report is echoed on one line (control for the success message)', async (t) => {
    const target = path.join(dir, `report${'\n'}FORGED line.txt`);
    let wrote = true;
    try {
      fs.writeFileSync(target, '');
      fs.rmSync(target);
    } catch {
      wrote = false;
    }
    if (!wrote) {
      t.skip('this file system does not take a line feed in a name');
      return;
    }
    const lines: string[] = [];
    const io = { stdout: (s: string) => lines.push(s), stderr: (s: string) => lines.push(s) };
    await main(['--html-file', okHtml, '--markdown-file', okMarkdown, '--output', target], io);
    fs.rmSync(target, { force: true });
    for (const chunk of lines) for (const line of chunk.split(/\r\n|\r|\n/)) assert.ok(!line.startsWith('FORGED'), line);
  });

  it('an unknown option name that holds a credential is masked in the error', () => {
    for (const w of ALL) {
      const r = spawnSync(process.execPath, [CLI, `--https://usr:${HEAD}${WS[w]}${TAIL}@h.example/p`], { encoding: 'utf8', timeout: 20000 });
      assert.equal(leaked(`${r.stdout}${r.stderr}`), null, w);
    }
  });

  it('a selector that holds a credential is masked in the error and in the report', () => {
    for (const w of ALL) {
      const r = spawnSync(process.execPath, [CLI, '--html-file', okHtml, '--markdown-file', okMarkdown, '--selector', `https://usr:${HEAD}${WS[w]}${TAIL}@h.example/p`, '--format', 'json'], { encoding: 'utf8', timeout: 20000 });
      assert.equal(leaked(`${r.stdout}${r.stderr}`), null, w);
    }
  });
});

// The cost tests do not assert a time. They run three sizes, each double the one before, and require that the time of
// the largest is not about 16 times the time of the smallest, which is what a quadratic cost gives (a linear one gives
// about 4). The floor keeps a fast, noisy run from failing the ratio.
describe('the white space and bare host rules of the masking are linear', () => {
  const T = WS.TAB;
  const inputs: Record<string, (n: number) => string> = {
    'authorities with a tab and no slash': (n) => `https://u:p${T}q@h `.repeat(n / 16),
    'a colon and a tab before every at sign': (n) => `https://u:${T}@`.repeat(n / 10),
    'one long authority of tabs': (n) => `a://${T.repeat(n)}@`,
    'one long authority of colons': (n) => `a://${':'.repeat(n)}${T}@x`,
    'scheme separators in a row': (n) => '://'.repeat(n / 3),
    'bare hosts with anchors': (n) => 'example.com/p#a '.repeat(n / 16),
    'a chain of hosts and fragments': (n) => `${'a.b#'.repeat(n / 4)}=x`,
  };
  const time = (fn: () => void): number => {
    let best = Infinity;
    for (let i = 0; i < 2; i++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const functions: Record<string, (s: string) => unknown> = {
    strictNormalize,
    dropAuthorityControls,
    redactText,
    hideUrlSecrets,
    'maskAuthorityUserinfo with white space inside': (s) => maskAuthorityUserinfo(s, true),
    'user information of a source text': (s) => {
      const spans = userinfoSpansOf(s);
      for (let i = 0; i < s.length; i += 101) insideUserinfoSpan(spans, i);
      return spans.length;
    },
  };
  for (const [fname, fn] of Object.entries(functions)) {
    it(fname, () => {
      for (const [iname, make] of Object.entries(inputs)) {
        const t = [64000, 128000, 256000].map((n) => {
          const s = make(n);
          return time(() => fn(s));
        });
        assert.ok(t[2]! < 8 * Math.max(t[0]!, 30), `${iname}: ${t.map((x) => x.toFixed(0)).join(' ms, ')} ms`);
      }
    });
  }
});
