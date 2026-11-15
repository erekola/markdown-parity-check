// Regression tests for release 0.2.39, the fixes that follow an outside security-audit read of 0.2.38: no forged line in
// the text report, credential masking for four more shapes, three linear-time fixes, a link target length limit, the
// command line started without its .js extension, a capped selector echo, the IPv6 allowlist, white space inside user
// information, bare hosts that are not dotted names and a line break in an argument echoed in an error.
// A test whose name ends in "(control)" pins behaviour that must not change; the others fail on 0.2.38, except the
// pins of the release check and of the proxy variable, which hold on both.
// The cost tests do not assert a time. They run three sizes, each double the one before, and require that the time
// of the largest is not about 16 times the time of the smallest, which is what a quadratic cost gives (a linear one
// gives about 4). The floor keeps a fast, noisy run from failing the ratio.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { AlignmentLimitError, align } from '../src/align.js';
import { compare } from '../src/compare.js';
import { main } from '../src/cli.js';
import { extractHtml } from '../src/html.js';
import { isPublicAddress, isPublicIPv6 } from '../src/netguard.js';
import { normalizeCode, redactText, stripControlChars } from '../src/normalize.js';
import { renderJson, renderText } from '../src/report.js';
import { run, RunError, type RunOptions, type SourceInput } from '../src/run.js';
import type { Block } from '../src/model.js';
import { TOOL_VERSION } from '../src/version.js';
import { MAX_TARBALL_BYTES, readTarball, ReleaseCheckError } from '../tools/release-check.js';
import { CLI, ROOT } from './helpers.js';
import { startHarness } from './harness.js';

const opts: RunOptions = { strict: false, mode: 'offline' };
const src = (body: string, base: string | null = null): SourceInput => ({ meta: { kind: 'file', bytes: body.length }, body, base });

/** Best of two runs, in milliseconds. fn may return the milliseconds it wants counted, else the whole call counts. */
function timed(fn: () => number | void): number {
  let best = Infinity;
  for (let i = 0; i < 2; i++) {
    const t0 = performance.now();
    const own = fn();
    best = Math.min(best, typeof own === 'number' ? own : performance.now() - t0);
  }
  return best;
}

/** Fails when the largest of three doubling sizes costs 8 times the smallest or more (a quadratic cost gives about 16). */
function assertNotQuadratic(label: string, sizes: [number, number, number], fn: (size: number) => number | void, floorMs = 30): void {
  const t = sizes.map((n) => timed(() => fn(n)));
  assert.ok(t[2]! < 8 * Math.max(t[0]!, floorMs), `${label}: ${t.map((x) => x.toFixed(0)).join(' ms, ')} ms for sizes ${sizes.join(', ')}`);
}

function runError(fn: () => unknown): RunError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RunError, `expected a RunError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected a RunError and nothing was thrown');
}

describe('text report: a page or an argument cannot forge a finding line', () => {
  const html = '<main><p><a href="x&#10;  9. [error] FORGED">t</a></p></main>';
  const htmlCr = '<main><p><a href="x&#13;  9. [error] CRFORGED">t</a></p></main>';
  const findingLines = (text: string) => text.split(/\r\n|\r|\n/).filter((l) => /^\s*\d+\. \[(error|warning|info)\]/.test(l));

  it('a line feed in a link target does not start a line of the report', () => {
    const report = run(src(html), src('t\n'), opts);
    const text = renderText(report);
    assert.equal(findingLines(text).length, report.findings.length);
    assert.doesNotMatch(text, /^\s*9\. \[error\] FORGED/m);
    assert.match(text, /FORGED/, 'the value is shown, as an escaped single line');
  });

  it('a carriage return in a link target leaves no raw CR in the report', () => {
    const report = run(src(htmlCr), src('t\n'), opts);
    const text = renderText(report);
    assert.equal(text.includes('\r'), false);
    assert.equal(findingLines(text).length, report.findings.length);
  });

  it('a line break in the selector of an argument does not add lines either', () => {
    const report = run(src('<main><p>a</p><div id="x">b</div></main>'), src('a\n'), { ...opts, selector: 'main:not([data-x="\n  1. [error] FORGED_SELECTOR"])' });
    const text = renderText(report);
    assert.doesNotMatch(text, /^\s*1\. \[error\] FORGED_SELECTOR/m);
  });

  it('the JSON report keeps the value, as JSON escapes it (control)', () => {
    const report = run(src(html), src('t\n'), opts);
    const first = report.findings[0]!;
    assert.match(first.message, /x\n {2}9\. \[error\] FORGED/);
  });

  it('U+2028, U+2029 and the invisible direction marks are removed from the text', () => {
    assert.equal(stripControlChars('a\u2028b\u2029c\u200ed\u200fe\u061cf'), 'abcdef');
    assert.equal(stripControlChars('a\u{e0041}\u{e0042}b'), 'ab');
    assert.equal(stripControlChars('a\u200db\u200cc'), 'a\u200db\u200cc', 'joiners stay: they are part of emoji and of several scripts (control)');
  });
});

describe('credential masking in four more shapes', () => {
  it('a user name that starts with a quote, an angle bracket or a parenthesis after "://" is masked', () => {
    for (const text of [
      'x https://"admin":SYNTHETICPW@host.example/ y',
      "https://'admin':SYNTHETICPW@host.example/",
      'https://<admin>:SYNTHETICPW@host.example/',
      'https://(SYNTHETICPW)@host.example/',
      'https://(admin):SYNTHETICPW@host.example/',
    ]) {
      const out = redactText(text);
      assert.doesNotMatch(out, /SYNTHETICPW/, text);
      assert.match(out, /host\.example/, text);
    }
  });

  it('a URL that follows "=", "," or ":" in the same run is masked, also with a query', () => {
    for (const text of [
      'export DATABASE_URL=postgres://admin:SYNTHETICPW@db.example/app?sslmode=require now',
      'see url=https://u:SYNTHETICPW@h.example/p?a=1',
      'redirect_uri=https://u:SYNTHETICPW@h.example/cb?state=1',
      'a,https://u:SYNTHETICPW@h.example/p?a=1',
      'see:https://u:SYNTHETICPW@h.example/p?a=1',
    ]) {
      const out = redactText(text);
      assert.doesNotMatch(out, /SYNTHETICPW/, text);
      assert.doesNotMatch(out, /(?:a|state|sslmode)=(?:1|require)/, `the query value stays masked: ${text}`);
    }
    assert.equal(redactText('DATABASE_URL=postgres://admin:SYNTHETICPW@db.example/app'), 'DATABASE_URL=postgres://db.example/app', '(control)');
  });

  it('a bare host with a path, a query or a fragment is masked like a URL', () => {
    assert.equal(redactText('Callback example.com/cb#access_token=SYNTHETICTOKEN done'), 'Callback example.com/cb done');
    assert.doesNotMatch(redactText('see example.com/p?a[0]=SYNTHETICTOKEN'), /SYNTHETICTOKEN/);
    assert.equal(redactText('ref https://example.com/cb#access_token=SYNTHETICTOKEN done'), 'ref https://example.com/cb done', '(control)');
    assert.equal(redactText('see the file docs/starlight.md for details'), 'see the file docs/starlight.md for details', 'a file path is not a host (control)');
    assert.equal(redactText('e.g. v1.2/3 and i.e./x'), 'e.g. v1.2/3 and i.e./x', '(control)');
  });

  it('a raw space in the user information of an argument does not leak through any echo', async () => {
    const pw = 'https://user:pa ss@example.com/x';
    const okHtml = path.join(ROOT, 'test', 'fixtures', 'same', 'page.html');
    const okMd = path.join(ROOT, 'test', 'fixtures', 'same', 'page.md');
    const argvs: string[][] = [
      ['--html-file', pw, '--markdown-file', okMd],
      ['--html-file', okHtml, '--markdown-file', pw, '--format', 'json'],
      ['--html-file', okHtml, '--markdown-file', okMd, '--output', pw + '/nonexistent-dir/report.txt'],
      [pw],
    ];
    for (const argv of argvs) {
      let out = '';
      let err = '';
      await main(argv, { stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
      assert.doesNotMatch(out + err, /pa ss|ss@|\bpa\b/, JSON.stringify(argv));
    }
  });

  it('a plain file path in an error is still shown as it is (control)', async () => {
    let err = '';
    await main(['--html-file', path.join(ROOT, 'no-such-dir', 'a.html'), '--markdown-file', 'b.md'], { stdout: () => {}, stderr: (s) => { err += s; } });
    assert.match(err, /Cannot read .*no-such-dir.*a\.html/);
  });
});

describe('normalizeCode is linear in a run of trailing newlines', () => {
  it('the time does not grow with the square of the run', () => {
    assertNotQuadratic('normalizeCode', [20_000, 40_000, 80_000], (n) => {
      normalizeCode('\n'.repeat(n) + 'x');
    });
  });
  it('still removes every trailing newline and nothing else (control)', () => {
    assert.equal(normalizeCode('a\r\nb\r\n\r\n\n'), 'a\nb');
    assert.equal(normalizeCode('a\n\n x \n'), 'a\n\n x ');
    assert.equal(normalizeCode('\n\n\n'), '');
    assert.equal(normalizeCode('a\rb\r'), 'a\nb');
    assert.equal(normalizeCode(''), '');
  });
});

describe('the Starlight class check does not grow with class length times block count', () => {
  it('the time does not grow with the square of the input', () => {
    assertNotQuadratic('starlight hasClass', [1, 2, 4], (n) => {
      const html = `<main><section class="${'a '.repeat(10_000 * n)}">${'<pre></pre>'.repeat(500 * n)}</section></main>`;
      extractHtml(html, { profile: 'starlight' });
    });
  });
  it('still finds the class on an element with many classes (control)', () => {
    const html = '<main><div class="expressive-code  x   y"><figure><figcaption><span class="sr-only">Terminal window</span></figcaption><pre><code>echo</code></pre></figure></div></main>';
    const e = extractHtml(html, { profile: 'starlight' });
    assert.ok(e.blocks.some((b) => b.type === 'code'));
    assert.equal(e.blocks.map((b) => b.text).join('|').includes('Terminal window'), false);
  });
});

describe('a link target over 8192 characters stops the run with a clean error', () => {
  const long = (n: number) => 'p'.repeat(n);
  it('a target of 8192 characters is compared as before (control)', () => {
    const href = `https://example.com/${long(8192 - 20)}`;
    assert.equal(href.length, 8192);
    const r = run(src(`<main><p><a href="${href}">a</a></p></main>`), src(`[a](${href})\n`), opts);
    assert.equal(r.summary.result, 'pass');
  });
  it('an HTML link target of 8193 characters is a RunError that names the limit and not the target', () => {
    const e = runError(() => run(src(`<main><p>a <a href="${long(8193)}">a</a></p></main>`), src('a [a](/q)\n'), opts));
    assert.match(e.message, /8192/);
    assert.match(e.message, /link target/i);
    assert.doesNotMatch(e.message, /ppppp/);
  });
  it('an inline Markdown link target and a reference definition are held to the same limit', () => {
    runError(() => run(src('<main><p>a</p></main>'), src(`[a](<${long(9000)}>)\n`), opts));
    runError(() => run(src('<main><p>a</p></main>'), src(`[a]: https://example.com/${long(9000)}\n\n[a] [a] [a]\n`), opts));
  });
  it('a raw anchor opened in one Markdown block and a long target in its href are held to it too', () => {
    runError(() => run(src('<main><p>a</p></main>'), src(`<a href="https://example.com/${long(9000)}">\n\n${'p\n\n'.repeat(50)}`), opts));
    runError(() => run(src('<main><p>a</p></main>'), src(`<div hidden>\n\n<a href="${long(9000)}">\n\n${'<br>\n\n'.repeat(50)}`), opts));
  });
  it('the shapes that cost minutes before stop at once', () => {
    const t0 = performance.now();
    runError(() => run(src(`<main><p>${'a '.repeat(8000)}<a href="${long(100_000)}">a</a></p></main>`), src('[a](/q) '.repeat(8000) + '\n'), opts));
    runError(() => run(src('<main><p>a</p></main>'), src(`[a]: https://example.com/${long(1_000_000)}\n\n${'[a] '.repeat(8000)}\n`), opts));
    assert.ok(performance.now() - t0 < 3000, 'the check comes before the work');
  });
  it('a <base href> over the limit is held to it as well', () => {
    runError(() => run(src(`<html><head><base href="https://example.com/${long(9000)}/"></head><body><main><p>a</p></main></body></html>`), src('a\n'), opts));
  });
  it('a block whose link targets together are longer than a string can be is an alignment limit error', () => {
    const big = 'x'.repeat(2 ** 28);
    const block = (): Block => ({
      type: 'paragraph',
      text: 'a',
      loose: 'a',
      numbers: [],
      location: { blockIndex: 0 },
      links: [1, 2, 3].map(() => ({ text: 't', rawHref: big, resolved: big })),
    });
    assert.throws(() => align([block()], [block()]), (err: unknown) => err instanceof AlignmentLimitError && /link/i.test((err as Error).message));
  });
});

describe('the cell loop of a ragged table is linear in the cells that exist', () => {
  it('one wide row among many narrow ones does not cost rows times width', () => {
    assertNotQuadratic('compareTables', [2500, 5000, 10_000], (r) => {
      const w = r * 3;
      const html = '<main><table><tr>' + '<td></td>'.repeat(w) + '</tr>' + '<tr><td>x</td></tr>'.repeat(r - 1) + '</table></main>';
      const a = extractHtml(html);
      const b = extractHtml(html);
      const t0 = performance.now();
      compare(a, b, { bothBases: false });
      // Only the comparison is timed: the extraction is linear and takes more time than the loop once it is fixed.
      return performance.now() - t0;
    });
  });
  it('still reports a changed cell, also in a cell past the end of the shorter row (control)', () => {
    const h = extractHtml('<main><table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table></main>');
    const m = extractHtml('<main><table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>5</td></tr></table></main>');
    const r = compare(h, m, { bothBases: false });
    assert.equal(r.findings.filter((f) => f.code === 'TABLE_CELL_CHANGED').length, 1);
  });
});

describe('the selector echo is capped at 120 characters in every place', () => {
  it('the strategy of the extraction', () => {
    const selector = 'main:not([data-x="' + 'A'.repeat(400_000) + '"])';
    const e = extractHtml('<main><p>a</p></main>', { selector });
    assert.ok(e.strategy.length <= 'selector:'.length + 120, String(e.strategy.length));
  });
  it('the empty-root error of the run', () => {
    const selector = '#e:not([data-x="' + 'A'.repeat(400_000) + '"])';
    const e = runError(() => run(src('<main><p>a</p></main><div id="e"></div>'), src('a\n'), { ...opts, selector }));
    assert.ok(e.message.length < 400, String(e.message.length));
  });
  it('the message of a selector the parser refuses', () => {
    const selector = ':nth-child(' + 'x'.repeat(100_000) + ')';
    const e = runError(() => run(src('<main><p>a</p></main>'), src('a\n'), { ...opts, selector }));
    assert.ok(e.message.length < 400, String(e.message.length));
    assert.match(e.message, /^Invalid selector/);
  });
  it('a short selector is echoed whole (control)', () => {
    const e = extractHtml('<main><p>a</p></main>', { selector: 'main > p' });
    assert.equal(e.strategy, 'selector:main > p');
  });
});

describe('IPv6 address policy: only 2000::/3 is public', () => {
  it('forms outside 2000::/3 that the deny list let through are refused', () => {
    for (const ip of ['0:1::1', '8000::1', '4000::1', 'a000::1', 'e000::1', '100:0:0:2::1', '1::1', '6000::1', 'dead:beef::1']) {
      assert.equal(isPublicIPv6(ip), false, ip);
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });
  it('ordinary public addresses stay public (control)', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e', '2620:fe::fe', '3fff:1000::1']) {
      assert.equal(isPublicIPv6(ip), true, ip);
    }
  });
  it('the embedded IPv4 forms still follow the IPv4 address (control)', () => {
    assert.equal(isPublicIPv6('::ffff:8.8.8.8'), true);
    assert.equal(isPublicIPv6('::ffff:127.0.0.1'), false);
    assert.equal(isPublicIPv6('64:ff9b::8.8.8.8'), true);
    assert.equal(isPublicIPv6('64:ff9b::10.0.0.1'), false);
    assert.equal(isPublicIPv6('2002:808:808::1'), true);
    assert.equal(isPublicIPv6('2002:7f00:1::1'), false);
  });
  it('the private, link-local, multicast and documentation ranges stay refused (control)', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '3fff::1']) {
      assert.equal(isPublicIPv6(ip), false, ip);
    }
  });
});

describe('the command starts without its .js extension', () => {
  it('prints the version from an absolute path, a path with "..", and a relative path', () => {
    const bare = CLI.replace(/\.js$/, '');
    for (const [cmd, cwd] of [
      [bare, undefined],
      [path.join(path.dirname(bare), '..', 'src', 'cli'), undefined],
      [path.join('dist', 'src', 'cli'), ROOT],
    ] as const) {
      const r = spawnSync(process.execPath, [cmd, '--version'], { encoding: 'utf8', cwd });
      assert.equal(r.stdout, `${TOOL_VERSION}\n`, `${cmd}: ${r.stderr}`);
      assert.equal(r.status, 0);
    }
  });
  it('a missing file gives exit 2 without the extension too', () => {
    const r = spawnSync(process.execPath, [CLI.replace(/\.js$/, ''), '--html-file', path.join(ROOT, 'nope.html'), '--markdown-file', path.join(ROOT, 'nope.md')], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Cannot read/);
  });
  it('the path with its extension still works (control)', () => {
    const r = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
    assert.equal(r.stdout, `${TOOL_VERSION}\n`);
  });
});

describe('the README names what the comparison leaves out and the limits of a library call', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  it('names aria-hidden, HTML comments and unused link reference definitions as left out', () => {
    assert.match(readme, /`aria-hidden="true"`/);
    assert.match(readme, /HTML comment/);
    assert.match(readme, /unused link reference definition/i);
  });
  it('states the link target limit and that a library caller needs its own time and memory limit', () => {
    assert.match(readme, /8192/);
    assert.match(readme, /time limit and a memory limit of its own/i);
  });
  it('names the two parser dependencies whose cost is not bounded here', () => {
    assert.match(readme, /micromark-extension-gfm/);
    assert.match(readme, /mdast-util-find-and-replace/);
  });
  it('the version in the README example is the version of the package (control)', () => {
    assert.ok(readme.includes(`markdown-parity-check ${TOOL_VERSION} (offline mode)`));
  });
});

describe('redaction: white space inside user information', () => {
  const gaps: Array<[string, string]> = [
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
    ['vertical tab', '\u000b'],
    ['form feed', '\u000c'],
    ['U+0085', '\u0085'],
    ['tab', '\t'],
    ['line feed', '\n'],
    ['carriage return', '\r'],
    ['no-break space', '\u00a0'],
    ['space', ' '],
  ];
  it('no part of the secret remains when a white space or invisible character sits inside the user information', () => {
    for (const [name, gap] of gaps) {
      for (const text of [
        `https://u:SYNTHETICPW${gap}@h.example/`,
        `see https://u:SYNTHETICPW${gap}@h.example/p now`,
        `https://us${gap}er:SYNTHETICPW@h.example/`,
        `https://u:SYN${gap}THETICPW@h.example/a?k=1`,
      ]) {
        const out = redactText(text);
        assert.doesNotMatch(out, /SYN|THETICPW/, `${name}: ${JSON.stringify(text)} gave ${JSON.stringify(out)}`);
        assert.match(out, /h\.example/, `${name}: the host stays`);
      }
    }
  });
  it('a character reference for such a character in an HTML page does not carry the secret into either report', () => {
    for (const ref of ['&#x0b;', '&#x2028;', '&#x2029;', '&#12;', '&#133;', '&#9;', '&#10;', '&#xa0;', '&#32;']) {
      const report = run(src(`<main><p>see https://u:SYNTHETICPW${ref}@h.example/p now</p></main>`), src('see other words now\n'), opts);
      assert.ok(report.findings.length > 0, ref);
      assert.doesNotMatch(renderText(report), /SYN|THETICPW/, `text report, ${ref}`);
      assert.doesNotMatch(renderJson(report), /SYN|THETICPW/, `JSON report, ${ref}`);
    }
  });
  it('a space after a host with no colon before it is prose, not user information (control)', () => {
    assert.equal(redactText('visit https://example.com for me@x.org'), 'visit https://example.com/ for me@x.org');
    assert.equal(redactText('https://user:pw@host.example/p'), 'https://host.example/p');
    assert.equal(redactText('email a@b.c, then https://example.com: see c@d.e'), 'email a@b.c, then https://example.com/: see c@d.e');
  });
});

describe('redaction: a bare host that is not a dotted name', () => {
  it('masks the fragment of an IPv4 address, localhost, a punycode name, a name with an underscore and a host without a slash', () => {
    for (const text of [
      'see 192.168.0.1/cb#access_token=SYNTHETICTOKEN now',
      'see 192.168.0.1:8080/cb#t=SYNTHETICTOKEN now',
      'see localhost/cb#t=SYNTHETICTOKEN now',
      'see localhost:8080/cb#t=SYNTHETICTOKEN now',
      'see example.xn--p1ai/cb#t=SYNTHETICTOKEN now',
      'see x_y.example.com/cb#t=SYNTHETICTOKEN now',
      'see example.com#t=SYNTHETICTOKEN now',
      'see example.com\\cb#t=SYNTHETICTOKEN now',
      'see 192.168.0.1#t=SYNTHETICTOKEN now',
      'see LOCALHOST/p?k=SYNTHETICTOKEN',
    ]) {
      assert.doesNotMatch(redactText(text), /SYNTHETICTOKEN/, text);
    }
    assert.equal(redactText('see 192.168.0.1/cb#access_token=SYNTHETICTOKEN now'), 'see 192.168.0.1/cb now');
    assert.equal(redactText('see example.com#t=SYNTHETICTOKEN now'), 'see example.com now');
  });
  it('leaves ordinary prose alone (control)', () => {
    for (const text of [
      'README.md#section',
      'a.b#c',
      '1.2.3#x',
      '1.2.3.4#x',
      'version 1.2.3.4 released',
      'pi is 3.14 and 2.5#x',
      'file.txt#L10',
      'localhost is the loopback name',
      'localhost:8080 is the dev server',
      'example.com#top',
      'v1.2.3#readme',
      'the range 10.0.0.1 to 10.0.0.9.',
      'snake_case.py and my_file.txt',
    ]) {
      assert.equal(redactText(text), text);
    }
  });
});

describe('command line: a line break in an argument stays on one line in the error', () => {
  it('Cannot read, --output and a positional argument', async () => {
    const okHtml = path.join(ROOT, 'test', 'fixtures', 'same', 'page.html');
    const okMd = path.join(ROOT, 'test', 'fixtures', 'same', 'page.md');
    const forged = 'x\n  9. [error] FORGED\r  8. [error] FORGED2';
    const argvs: string[][] = [
      ['--html-file', forged, '--markdown-file', okMd],
      ['--html-file', okHtml, '--markdown-file', okMd, '--output', forged + '/nonexistent-dir/report.txt'],
      ['--html-file', okHtml, '--markdown-file', okMd, '--format', forged],
    ];
    for (const argv of argvs) {
      let err = '';
      await main(argv, { stdout: () => {}, stderr: (s) => { err += s; } });
      assert.equal(err.includes('\r'), false, JSON.stringify(argv));
      assert.equal(err.trimEnd().includes('\n'), false, JSON.stringify(err));
      assert.match(err, /FORGED/);
    }
  });
});

describe('the release check unpacks a bounded tarball', () => {
  it('a gzip stream that expands past the cap is a ReleaseCheckError', () => {
    const bomb = zlib.gzipSync(Buffer.alloc(MAX_TARBALL_BYTES + 1));
    assert.throws(() => readTarball(bomb), (e: unknown) => e instanceof ReleaseCheckError && /could not be unpacked/.test(e.message));
  });
});

describe('NODE_USE_ENV_PROXY does not send the fetch through a proxy', () => {
  it('a process that sets the variable connects to the address it checked and never to the proxy', async () => {
    const h = await startHarness();
    let targetHits = 0;
    h.server.on('request', () => {
      targetHits++;
    });
    let proxyHits = 0;
    const proxy = http.createServer((_req, res) => {
      proxyHits++;
      res.writeHead(502);
      res.end();
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const fetchModule = pathToFileURL(path.join(ROOT, 'dist', 'src', 'fetch.js')).href;
      const script = `import(${JSON.stringify(fetchModule)}).then(async (m) => { const r = await m.fetchUrl(process.argv[1], { accept: 'text/markdown', timeoutMs: 3000, maxBytes: 1048576, testAllowHosts: ['127.0.0.1'] }); console.log(r.status); });`;
      const env = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' };
      const child = spawn(process.execPath, ['-e', script, `http://127.0.0.1:${h.port}/ok`], { env });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d));
      child.stderr.on('data', (d: Buffer) => (err += d));
      await new Promise<void>((resolve) => child.on('close', () => resolve()));
      assert.equal(out.trim(), '200', err);
      assert.equal(targetHits, 1);
      assert.equal(proxyHits, 0);
    } finally {
      await h.close();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
