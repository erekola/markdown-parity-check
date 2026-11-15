// Regression tests for release 0.2.40: the credential-shaped "label:name@host/path" without a scheme separator, as in
// user:secret@host.example/p?x=1. The URL parser reads "user:" as a scheme and the rest as an opaque path, so the masking
// of 0.2.39 found no user information, and GFM read "secret@host.example" as an e-mail address, so the secret reached
// a report as an excerpt and as the text and the target of a link.
// The tests that name a secret fail on 0.2.39. A test whose name ends in "(control)" pins ordinary text that must be
// shown as it is. The masking is a display aid: test/comparison-keys.test.ts pins the comparison keys to 0.2.38.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bareUserinfoSpansOf, findBareUserinfoSpans, maskBareUserinfo, redactText } from '../src/normalize.js';
import { renderJson, renderText } from '../src/report.js';
import { run, type RunOptions, type SourceInput } from '../src/run.js';

const opts: RunOptions = { strict: false, mode: 'offline' };
const src = (body: string): SourceInput => ({ meta: { kind: 'file', bytes: body.length }, body, base: 'https://example.com/page' });

const SECRET = 'QzXv7Kp9Wm';
const QUADS: string[] = [];
for (let i = 0; i + 4 <= SECRET.length; i++) QUADS.push(SECRET.slice(i, i + 4));
const leaked = (out: string): string | null => QUADS.find((q) => out.includes(q)) ?? null;

/** Both report formats and the findings of the report object, as one string. */
function everything(html: string, markdown: string): string {
  const r = run(src(html), src(markdown), opts);
  return `${renderText(r)}\n${renderJson(r)}\n${JSON.stringify(r.findings)}`;
}

/** Fails when the largest of three doubling sizes costs 8 times the smallest or more (a quadratic cost gives about 16). */
function assertNotQuadratic(label: string, sizes: [number, number, number], fn: (size: number) => void, floorMs = 30): void {
  const t = sizes.map((n) => {
    let best = Infinity;
    for (let i = 0; i < 2; i++) {
      const t0 = performance.now();
      fn(n);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  });
  assert.ok(t[2]! < 8 * Math.max(t[0]!, floorMs), `${label}: ${t.map((x) => x.toFixed(0)).join(' ms, ')} ms for sizes ${sizes.join(', ')}`);
}

const positions: Record<string, (u: string) => [string, string]> = {
  text: (u) => [`<main><p>g ${u} now</p></main>`, `g ${u} later\n`],
  listItem: (u) => [`<main><ul><li>g ${u} now</li></ul></main>`, `- g ${u} later\n`],
  heading: (u) => [`<main><h2>g ${u} now</h2></main>`, `## g ${u} later\n`],
  cell: (u) => [`<main><table><tr><th>a</th></tr><tr><td>${u}</td></tr></table></main>`, `| a |\n|---|\n| ${u} x |\n`],
  htmlOnly: (u) => [`<main><p>g ${u} now</p><p>other</p></main>`, 'other\n'],
  mdOnly: (u) => [`<main><p>other</p></main>`, `other\n\ng ${u} later\n`],
  same: (u) => [`<main><p>g ${u} now</p></main>`, `g ${u} now\n\nextra\n`],
};

describe('a name and a secret before an at sign without a scheme separator', () => {
  const masked: Array<[string, string]> = [
    [`user:${SECRET}@host.tld/p`, 'user:***@host.tld/p'],
    [`user:${SECRET}@host.tld/p?x=1=2`, 'user:***@host.tld/p?x=***'],
    [`user:${SECRET}@host.tld?x=1`, 'user:***@host.tld?x=***'],
    [`user:${SECRET}@host.tld\\p`, 'user:***@host.tld\\p'],
    [`user:${SECRET}@host.tld:8080/p`, 'user:***@host.tld:8080/p'],
    [`user:${SECRET}@192.168.0.1/p`, 'user:***@192.168.0.1/p'],
    [`user:${SECRET}@localhost:8080/p`, 'user:***@localhost:8080/p'],
    [`user:${SECRET}@xn--p1ai.example/p`, 'user:***@xn--p1ai.example/p'],
    [`a:b:${SECRET}@host.tld/p`, 'a:***@host.tld/p'],
    [`k=user:${SECRET}@host.tld/p`, 'k=user:***@host.tld/p'],
    [`see (user:${SECRET}@host.tld/p) now`, 'see (user:***@host.tld/p) now'],
    [`user:${SECRET}@host.tld/p and user2:${SECRET}@other.tld/q`, 'user:***@host.tld/p and user2:***@other.tld/q'],
  ];
  for (const [input, expected] of masked) {
    it(`redactText masks ${input.replace(SECRET, 'SECRET')}`, () => {
      const out = redactText(input);
      assert.equal(leaked(out), null, out);
      assert.equal(out, expected);
      assert.equal(redactText(out), out, 'masking twice changes nothing');
    });
  }

  it('the fragment shape hides the secret and the fragment value', () => {
    const out = redactText(`user:${SECRET}@host.tld#a=1`);
    assert.equal(leaked(out), null, out);
    assert.doesNotMatch(out, /a=1/);
  });

  for (const [position, make] of Object.entries(positions)) {
    it(`no output of a run shows the secret, ${position}`, () => {
      const [h, m] = make(`user:${SECRET}@host.tld/p?x=1=2`);
      const out = everything(h, m);
      assert.equal(leaked(out), null, `${position} leaked ${leaked(out)}`);
    });
  }

  it('a link that GFM read out of the shape is shown masked, as text and as target', () => {
    const r = run(src(`<main><p>g user:${SECRET}@host.tld/p?x=1=2</p></main>`), src(`g user:${SECRET}@host.tld/p?x=1=2\n`), opts);
    const added = r.findings.find((f) => f.code === 'LINK_ADDED');
    assert.ok(added, 'the autolink is a finding');
    assert.equal(added.message, 'Link "***" (***) is in the Markdown block but not in the HTML block.');
    assert.equal(added.after, '***');
  });

  it('an angle autolink and an explicit link of the shape show no secret in the target', () => {
    const cases: Array<[string, string]> = [
      [`<main><p>g user:${SECRET}@host.tld/p</p></main>`, `g <user:${SECRET}@host.tld/p>\n`],
      ['<main><p>g x</p></main>', `g [x](user:${SECRET}@host.tld/p)\n`],
    ];
    for (const [html, md] of cases) {
      const out = everything(html, md);
      assert.equal(leaked(out), null, `${md}: ${leaked(out)}`);
      assert.match(out, /LINK_ADDED/);
    }
  });

  it('the comparison still sees the link: the finding codes do not depend on the masking', () => {
    const same = run(src(`<main><p>g user:${SECRET}@host.tld/p</p></main>`), src(`g user:${SECRET}@host.tld/p\n`), opts);
    assert.deepEqual(same.findings.map((f) => f.code), ['LINK_ADDED']);
    assert.equal(same.summary.exitCode, 1);
  });
});

describe('ordinary addresses keep their text', () => {
  const shown = [
    'mail jane@example.com',
    'mailto:jane@example.com',
    'mailto:jane@example.com/x',
    'Contact: jane@example.com',
    'Contact:jane@example.com',
    'Did you mean To:jane@example.com?',
    'To:jane@example.com#top',
    'jane@example.com/x',
    'sip:jane@example.com/x',
    'git@github.com:o/r.git',
    `user:${SECRET}@host.tld`,
    `user:${SECRET}@intranet/p`,
    `user:${SECRET}@host.tld./p`,
    `user:${SECRET}@host.tld?`,
    `user:${SECRET}@host.tld#top`,
    'user:@host.tld/p',
  ];
  for (const text of shown) {
    it(`redactText shows ${text.replace(SECRET, 'SECRET')} as it is (control)`, () => {
      assert.equal(maskBareUserinfo(text), text);
      assert.equal(findBareUserinfoSpans(text).length, 0);
    });
  }

  it('an address in a finding is shown whole, as text and as target (control)', () => {
    for (const text of ['mail jane@example.com', 'mailto:jane@example.com', 'Contact: jane@example.com']) {
      const r = run(src(`<main><p>g ${text}</p></main>`), src(`g ${text}\n`), opts);
      const out = `${renderText(r)}\n${renderJson(r)}`;
      assert.match(out, /jane@example\.com/, text);
      assert.doesNotMatch(out, /\*\*\*@example/, text);
    }
    const r = run(src('<main><p>g jane@example.com</p></main>'), src('g jane@example.com\n'), opts);
    const added = r.findings.find((f) => f.code === 'LINK_ADDED');
    assert.ok(added);
    assert.equal(added.message, 'Link "jane@example.com" (mailto:jane@example.com) is in the Markdown block but not in the HTML block.');
    assert.equal(added.after, 'mailto:jane@example.com');
  });

  it('a mailto link with a query keeps the address and hides the value (control)', () => {
    assert.equal(redactText('mailto:jane@example.com?subject=hi'), 'mailto:jane@example.com?subject=***');
  });

  it('the span finder gives the label start, the first character after the colon and the at sign', () => {
    const text = 'see user:abc@host.tld/p now';
    assert.deepEqual(findBareUserinfoSpans(text), [{ start: 4, from: 9, at: 12 }]);
    assert.deepEqual(bareUserinfoSpansOf(text), [{ start: 4, from: 9, at: 12 }]);
    assert.deepEqual(bareUserinfoSpansOf(text.replace('see ', 'see ' + String.fromCodePoint(0x200e))), [{ start: 4, from: 10, at: 13 }]);
  });
});

describe('the scan for the shape stays linear', () => {
  const sizes: [number, number, number] = [20_000, 40_000, 80_000];
  it('a long chain of labels with colons and an at sign', () => {
    assertNotQuadratic('labels', sizes, (n) => {
      redactText('a:'.repeat(n) + '@x');
    });
  });
  it('many candidates that fail at a number sign', () => {
    assertNotQuadratic('failing candidates', sizes, (n) => {
      redactText('a:b@c.de#'.repeat(n));
    });
  });
  it('many candidates that succeed', () => {
    assertNotQuadratic('succeeding candidates', sizes, (n) => {
      redactText('a:b@c.de/'.repeat(n));
    });
  });
  it('many at signs and one long query name', () => {
    assertNotQuadratic('at signs', sizes, (n) => {
      redactText('x@'.repeat(n) + '/' + 'a:b@c.de?' + 'a'.repeat(n));
    });
  });
  it('many candidates behind a query name that is never closed', () => {
    assertNotQuadratic('open query', sizes, (n) => {
      redactText('a:b@c.de?aaaa'.repeat(n));
    });
  });
  it('the span finder of a source with many autolinks', () => {
    assertNotQuadratic('source spans', [2000, 4000, 8000], (n) => {
      bareUserinfoSpansOf('x user:pw@host.tld/p y '.repeat(n));
    });
  });
});

// Found by the independent check of 0.2.40 before release: maskHref drops the fragment first, so a link target
// whose only delimiter is a fragment lost the shape before the scheme-less masking looked at it.
describe('a link target whose only delimiter after the host is a fragment', () => {
  const target = `user:${SECRET}@host.tld#a=b`;
  const cases: Record<string, [string, string]> = {
    inline: ['<main><p>t</p></main>', `[t](${target})\n`],
    angle: ['<main><p>t</p></main>', `[t](<${target}>)\n`],
    reference: ['<main><p>t</p></main>', `[t][r]\n\n[r]: ${target}\n`],
    rawAnchor: ['<main><p>t</p></main>', `<a href="${target}">t</a>\n`],
    htmlSide: [`<main><p><a href="${target}">t</a></p></main>`, 't\n'],
    autolink: [`<main><p>${target}</p></main>`, `<${target}>\n`],
  };
  for (const [name, [html, markdown]] of Object.entries(cases)) {
    it(`${name}: no part of the secret reaches a report`, () => {
      const out = everything(html, markdown);
      assert.equal(leaked(out), null);
      assert.match(out, /LINK_/);
    });
  }
  it('the same target with a path or a query value stays masked', () => {
    for (const t of [`user:${SECRET}@host.tld/p#a=b`, `user:${SECRET}@host.tld?k=v`]) {
      assert.equal(leaked(everything('<main><p>t</p></main>', `[t](${t})\n`)), null);
    }
  });
});
