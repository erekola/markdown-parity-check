// Regressions for the outside review of 2026-10-02 (turva npm packages quality review, P01 to P09 and P11), all Erik's
// decision (0.2.22). Most of them move the set of inputs that pass or stop. Every case has a control that must keep its
// result, so a fix cannot pass by widening or narrowing the rule beyond the decided case.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CliError, main, parseCliArgs } from '../src/cli.js';
import { compare } from '../src/compare.js';
import { extractHtml } from '../src/html.js';
import { extractMarkdown } from '../src/markdown.js';
import type { Block, Extraction } from '../src/model.js';
import { run, type SourceInput } from '../src/run.js';

const input = (body: string, file: string): SourceInput => ({ body, base: null, meta: { kind: 'file', file, bytes: Buffer.byteLength(body, 'utf8'), baseUrl: null } });
const strictOpts = { strict: true, mode: 'offline' as const };
const defaultOpts = { strict: false, mode: 'offline' as const };
const check = (html: string, md: string, opts = strictOpts) => run(input(html, 'page.html'), input(md, 'page.md'), opts);
const codes = (html: string, md: string, opts = strictOpts): string[] => check(html, md, opts).findings.map((f) => `${f.code}:${f.severity}`);
const exitOf = (html: string, md: string, opts = strictOpts): number => check(html, md, opts).summary.exitCode;

describe('P01: a rejected --format or --front-matter value is not echoed with credentials', () => {
  const secret = 'ftp://user:pa ss@example.test/?token=TOKEN#FRAG';
  const leak = /user|pa ss|TOKEN|FRAG/;

  it('parseCliArgs masks the value in both messages and keeps the rest of the sentence', () => {
    for (const flag of ['--format', '--front-matter']) {
      let message = '';
      try {
        parseCliArgs([flag, secret]);
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        message = err.message;
      }
      assert.match(message, flag === '--format' ? /^--format must be text or json \(got "/ : /^--front-matter must be keep or strip \(got "/);
      assert.doesNotMatch(message, leak, message);
    }
  });

  it('the CLI repeats nothing of it on stdout (json) or stderr, and still exits 2', async () => {
    for (const flag of ['--format', '--front-matter']) {
      let out = '';
      let err = '';
      const argv = flag === '--format' ? [flag, secret] : [flag, secret, '--format', 'json'];
      const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s) });
      assert.equal(code, 2);
      assert.ok((out + err).length > 0);
      assert.doesNotMatch(out + err, leak, out + err);
    }
  });

  it('control: a plain wrong value is still shown, and the valid values still parse', () => {
    assert.throws(() => parseCliArgs(['--format', 'xml']), /\(got "xml"\)/);
    assert.throws(() => parseCliArgs(['--front-matter', 'drop']), /\(got "drop"\)/);
    assert.equal(parseCliArgs(['--format', 'json', '--help']).format, 'json');
  });
});

describe('P02: an automatic root inside left-out content is not the main content', () => {
  it('an article inside a nav is not used, and the body is compared instead', () => {
    const html = '<body><nav><article><p>Menu</p></article></nav><p>Body</p></body>';
    const e = extractHtml(html);
    assert.equal(e.strategy, 'body-fallback');
    assert.deepEqual(e.blocks.map((b) => b.text), ['Body']);
    assert.ok(e.notes.some((n) => /inside left-out content/.test(n)));
    assert.equal(exitOf(html, 'Menu'), 1);
    assert.ok(codes(html, 'Menu').includes('BLOCK_MISSING:error'));
    assert.equal(exitOf(html, 'Body', defaultOpts), 0);
  });

  it('a main inside a page-wide form is still the main content, as it was before 0.2.22', () => {
    const html = '<body><form><main><p>Body text</p></main></form></body>';
    assert.equal(extractHtml(html).strategy, 'main');
    assert.equal(exitOf(html, 'Body text'), 0);
    assert.equal(extractHtml('<body><form role="search"><main><p>Find</p></main></form><p>Body</p></body>').strategy, 'body-fallback');
  });

  it('a main with a left-out role, or inside a search role or a dialog, is not used either', () => {
    assert.equal(extractHtml('<body><main role="navigation"><p>Menu</p></main><p>Body</p></body>').strategy, 'body-fallback');
    assert.equal(extractHtml('<body><div role="search"><main><p>Find</p></main></div><p>Body</p></body>').strategy, 'body-fallback');
    assert.equal(extractHtml('<body><dialog><main><p>Hi</p></main></dialog><p>Body</p></body>').strategy, 'body-fallback');
  });

  it('a later candidate outside the left-out content is chosen', () => {
    const e = extractHtml('<body><nav><article><p>Menu</p></article></nav><main><p>Body</p></main></body>');
    assert.equal(e.strategy, 'main');
    assert.deepEqual(e.blocks.map((b) => b.text), ['Body']);
  });

  it('controls: ordinary candidates are chosen as before, and an explicit selector stays the user choice', () => {
    assert.equal(extractHtml('<body><div><main><p>A</p></main></div></body>').strategy, 'main');
    assert.equal(extractHtml('<body><article><p>A</p></article></body>').strategy, 'article');
    assert.equal(extractHtml('<body><section role="main"><p>A</p></section></body>').strategy, '[role=main]');
    assert.equal(exitOf('<body><header><p>Site</p></header><main><p>Body</p></main></body>', 'Body'), 0);
    assert.equal(extractHtml('<body><nav><article><p>Menu</p></article></nav></body>', { selector: 'article' }).blocks[0]?.text, 'Menu');
  });
});

describe('P03: a checkbox inside a left-out subtree does not set the task state', () => {
  const item = (inner: string) => `<main><ul><li>${inner}</li></ul></main>`;

  it('a checked box in a form does not answer for the unchecked box that is part of the item', () => {
    const html = item('<form><input type="checkbox" checked></form><input type="checkbox">Ship');
    assert.deepEqual(codes(html, '- [x] Ship'), ['LIST_TASK_CHANGED:error']);
    assert.equal(exitOf(html, '- [ ] Ship'), 0);
  });

  it('a form checkbox alone gives no task state, so a plain Markdown item passes', () => {
    const html = item('<form><input type="checkbox" checked></form>Ship');
    assert.equal(exitOf(html, '- Ship'), 0);
  });

  it('a checkbox in a nav, a template, a dialog or a role="navigation" element is ignored the same way', () => {
    for (const [open, close] of [['<nav>', '</nav>'], ['<template>', '</template>'], ['<dialog>', '</dialog>'], ['<div role="navigation">', '</div>']]) {
      const html = item(open + '<input type="checkbox" checked>' + close + '<input type="checkbox">Ship');
      assert.deepEqual(codes(html, '- [x] Ship'), ['LIST_TASK_CHANGED:error'], open);
    }
  });

  it('controls: the item own checkbox, also inside a label, and a hidden one, behave as before', () => {
    assert.equal(exitOf(item('<input type="checkbox" checked>Ship'), '- [x] Ship'), 0);
    assert.equal(exitOf(item('<label><input type="checkbox" checked>Ship</label>'), '- [x] Ship'), 0);
    assert.deepEqual(codes(item('<input type="checkbox" checked>Ship'), '- [ ] Ship'), ['LIST_TASK_CHANGED:error']);
    assert.equal(exitOf(item('<input type="checkbox" checked hidden><input type="checkbox">Ship'), '- [ ] Ship'), 0);
  });
});

describe('P04: a br inside code is a line break', () => {
  it('one<br>two in a pre is two lines', () => {
    const e = extractHtml('<main><pre>one<br>two</pre></main>');
    assert.equal(e.blocks[0]?.code, 'one\ntwo');
  });

  it('a fence with two lines now matches the br form, and a fence with the joined word no longer does', () => {
    const html = '<main><pre>one<br>two</pre></main>';
    assert.equal(exitOf(html, '```\none\ntwo\n```\n'), 0);
    assert.ok(codes(html, '```\nonetwo\n```\n').includes('BLOCK_MISSING:error'));
  });

  it('a br inside a hidden or skipped element adds nothing, and a br in a paragraph is still a space', () => {
    assert.equal(extractHtml('<main><pre>one<span hidden><br></span>two</pre></main>').blocks[0]?.code, 'onetwo');
    assert.equal(extractHtml('<main><pre>one<button><br></button>two</pre></main>').blocks[0]?.code, 'onetwo');
    assert.equal(exitOf('<main><p>one<br>two</p></main>', 'one two\n'), 0);
  });

  it('the Starlight profile reads a br in a line the same way', () => {
    const html = '<main><div class="expressive-code"><figure><pre data-language="js"><code><div class="ec-line"><div class="code">a<br>b</div></div></code></pre></figure></div></main>';
    assert.equal(extractHtml(html, { profile: 'starlight' }).blocks[0]?.code, 'a\nb');
  });
});

describe('P05: a code change is judged by whitespace only', () => {
  const fence = (code: string) => '```\n' + code + '\n```\n';
  const softHyphen = String.fromCharCode(0xad);
  const zeroWidth = String.fromCharCode(0x200b);

  it('a soft hyphen removed from code is TEXT_CHANGED, an error that fails the default run', () => {
    const html = '<main><pre>console.log("a&#173;b");</pre></main>';
    assert.deepEqual(codes(html, fence('console.log("ab");'), defaultOpts), ['TEXT_CHANGED:error']);
    assert.equal(exitOf(html, fence('console.log("ab");'), defaultOpts), 1);
    assert.deepEqual(codes(`<main><pre>console.log("a${softHyphen}b");</pre></main>`, fence('console.log("ab");')), ['TEXT_CHANGED:error']);
  });

  it('a zero width space and a composed against a decomposed letter are changes too', () => {
    assert.deepEqual(codes(`<main><pre>x${zeroWidth}y</pre></main>`, fence('xy')), ['TEXT_CHANGED:error']);
    const composed = String.fromCharCode(0xe9);
    const decomposed = 'e' + String.fromCharCode(0x301);
    assert.deepEqual(codes(`<main><pre>${composed}t</pre></main>`, fence(`${decomposed}t`)), ['TEXT_CHANGED:error']);
  });

  it('controls: indentation, tabs against spaces and line endings are still the whitespace warning, and equal code passes', () => {
    assert.deepEqual(codes('<main><pre>if (a) {\n  b();\n}</pre></main>', fence('if (a) {\n    b();\n}')), ['CODE_WHITESPACE_CHANGED:warning']);
    assert.deepEqual(codes('<main><pre>a\tb</pre></main>', fence('a b')), ['CODE_WHITESPACE_CHANGED:warning']);
    assert.equal(exitOf('<main><pre>a b</pre></main>', fence('a b'), defaultOpts), 0);
    assert.deepEqual(codes('<main><pre>ab</pre></main>', fence('a b')), ['BLOCK_MISSING:error', 'BLOCK_ADDED:error']);
  });
});

describe('P06: inline raw HTML in Markdown that the HTML side leaves out is left out', () => {
  it('a button or a script in a paragraph is skipped on both sides', () => {
    assert.equal(exitOf('<main><p>Hello <button>CLICK</button> world</p></main>', 'Hello <button>CLICK</button> world\n'), 0);
    assert.equal(exitOf('<main><p>Hello <script>secret()</script> world</p></main>', 'Hello <script>secret()</script> world\n'), 0);
    assert.equal(exitOf('<main><p>Hello world</p></main>', 'Hello <button>CLICK</button> world\n'), 0);
  });

  it('the same holds for a nav, a template, an svg, and an element with a left-out role', () => {
    for (const tag of ['nav', 'template', 'svg', 'select', 'textarea', 'noscript', 'iframe']) {
      assert.equal(exitOf('<main><p>Hello world</p></main>', `Hello <${tag}>gone</${tag}> world\n`), 0, tag);
    }
    assert.equal(exitOf('<main><p>Hello world</p></main>', 'Hello <span role="navigation">gone</span> world\n'), 0);
  });

  it('a nested element of the same name is skipped through its own closing tag', () => {
    assert.equal(exitOf('<main><p>Hello world</p></main>', 'Hello <form>a<form>b</form>c</form> world\n'), 0);
  });

  it('a tag with no closing tag is reported and its text compared as visible', () => {
    const report = check('<main><p>Hello world</p></main>', 'Hello <button>CLICK world\n');
    assert.ok(report.findings.some((f) => f.code === 'MARKDOWN_INLINE_HTML_UNSUPPORTED' && /left-out inline <button>/.test(f.message)));
    assert.equal(report.summary.exitCode, 1);
  });

  it('controls: an ordinary inline tag keeps its text, and visible text still has to match', () => {
    assert.equal(exitOf('<main><p>Hello <span>CLICK</span> world</p></main>', 'Hello <span>CLICK</span> world\n'), 0);
    assert.equal(exitOf('<main><p>Hello <em>CLICK</em> world</p></main>', 'Hello <span>OTHER</span> world\n'), 1);
    assert.equal(exitOf('<main><p>Hello <button>CLICK</button> world</p></main>', 'Hello CLICK world\n'), 1);
    assert.equal(exitOf('<main><p>Hello <span hidden>CLICK</span> world</p></main>', 'Hello <span hidden>CLICK</span> world\n'), 0);
  });
});

describe('P07: a hidden raw HTML wrapper that spans Markdown blocks hides what is inside', () => {
  const htmlPage = '<main><div hidden><p>Secret</p></div><p>Public</p></main>';

  it('the blank-line form from the review passes in strict mode', () => {
    assert.deepEqual(codes(htmlPage, '<div hidden>\n\nSecret\n\n</div>\n\nPublic\n'), []);
  });

  it('every kind of block inside the wrapper is hidden: heading, list, code, table, quote', () => {
    const md = '<div hidden>\n\n# Title\n\n- item\n\n```\ncode\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> quote\n\n</div>\n\nPublic\n';
    assert.deepEqual(codes('<main><p>Public</p></main>', md), []);
  });

  it('aria-hidden works the same, and so does a wrapper nested in a visible one', () => {
    assert.deepEqual(codes('<main><p>Public</p></main>', '<div aria-hidden="true">\n\nSecret\n\n</div>\n\nPublic\n'), []);
    assert.deepEqual(codes('<main><p>Public</p></main>', '<section>\n\n<div hidden>\n\nSecret\n\n</div>\n\nPublic\n\n</section>\n'), []);
  });

  it('the text after the closing tag is visible again, and a later extra block is still added', () => {
    assert.deepEqual(codes(htmlPage, '<div hidden>\n\nSecret\n\n</div>\n\nPublic\n\nExtra\n'), ['BLOCK_ADDED:error']);
    assert.deepEqual(codes('<main><p>Public</p></main>', '<div hidden>\n\nSecret\n\n</div>\n\nPublic\n\n<div hidden>\n\nMore\n\n</div>\n\nTail\n'), ['BLOCK_ADDED:error']);
  });

  it('a hidden wrapper that is never closed hides the rest of the document, as the page does', () => {
    assert.deepEqual(codes('<main><p>Before</p></main>', 'Before\n\n<div hidden>\n\nSecret\n\nMore\n'), []);
  });

  it('controls: a wrapper that is not hidden hides nothing, and the same wrapper inside one block is unchanged', () => {
    assert.deepEqual(codes('<main><div><p>Secret</p></div><p>Public</p></main>', '<div>\n\nSecret\n\n</div>\n\nPublic\n'), []);
    assert.deepEqual(codes('<main><p>Secret</p></main>', '<div>\n\nSecret\n\n</div>\n'), []);
    assert.deepEqual(codes('<main><p>Public</p></main>', '<div hidden><p>Secret</p></div>\n\nPublic\n'), []);
    assert.deepEqual(codes(htmlPage, '<div hidden>\n\nSecret\n\n</div>\n\nPublic\n', defaultOpts), []);
    assert.deepEqual(codes('<main><p>Secret</p><p>Public</p></main>', '<div hidden>\n\nSecret\n\n</div>\n\nPublic\n'), ['BLOCK_MISSING:error']);
  });

  it('the wrapper state is per document: a second extraction does not inherit it', () => {
    extractMarkdown('<div hidden>\n\nSecret\n');
    assert.deepEqual(extractMarkdown('Public\n').blocks.map((b) => b.text), ['Public']);
  });

  it('wrappers nested deeper than the limit still stop the run', () => {
    const open = '<div hidden>\n\nx\n\n'.repeat(1100);
    assert.throws(() => check('<main><p>a</p></main>', open), /nesting depth/);
  });
});

describe('P08: punctuation-only link labels pair by their unchanged target', () => {
  const linkCodes = (html: string, md: string): string[] => codes(html, md, defaultOpts).filter((c) => c.startsWith('LINK_')).sort();

  it('a changed punctuation label with the same target is a minor text change only', () => {
    const report = check('<main><p>Go <a href="/next">?</a></p></main>', 'Go [!](/next)\n', defaultOpts);
    assert.equal(report.summary.exitCode, 0);
    assert.deepEqual(report.findings.map((f) => f.code), ['TEXT_MINOR_CHANGED']);
    assert.equal(exitOf('<main><p>Go <a href="/next">?</a></p></main>', 'Go [!](/next)\n'), 1);
  });

  it('several such links pair by target in any order, and an unpaired one stays added', () => {
    const html = '<main><p><a href="/a">?</a> <a href="/b">!</a></p></main>';
    assert.deepEqual(linkCodes(html, '[!](/b) [?](/a)\n'), []);
    assert.deepEqual(linkCodes(html, '[;](/a) [:](/b) [.](/c)\n'), ['LINK_ADDED:error']);
  });

  it('controls: a different target is still a missing and an added link, and a plain label change is unchanged', () => {
    assert.deepEqual(linkCodes('<main><p>Go <a href="/a">?</a></p></main>', 'Go [!](/b)\n'), ['LINK_ADDED:error', 'LINK_MISSING:error']);
    assert.deepEqual(codes('<main><p><a href="/a">Home</a></p></main>', '[home](/a)\n', defaultOpts), ['TEXT_MINOR_CHANGED:warning']);
  });
});

describe('P09: a table of any number of rows does not overrun the call stack', () => {
  const side = (rows: number, cols: number): Extraction => {
    const table: Block = { type: 'table', text: 'x', loose: 'x', numbers: [], links: [], cells: Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'x')), location: { blockIndex: 0 } };
    return { blocks: [table], strategy: 'test', confidence: 'high', notes: [], issues: [] };
  };

  it('compare finishes on two identical tables of 300 000 rows', () => {
    assert.deepEqual(compare(side(300000, 1), side(300000, 1)).findings, []);
  });

  it('control: a shape difference is still reported', () => {
    assert.deepEqual(compare(side(3, 2), side(3, 3)).findings.map((f) => f.code), ['TABLE_SHAPE_CHANGED']);
  });
});

describe('P11: reordered blocks that were also edited are reported as moved', () => {
  const html = '<main><p>First alpha.</p><p>Second beta.</p></main>';

  it('the two-block reversal from the review reports one ORDER_CHANGED next to the two minor changes', () => {
    const found = codes(html, 'Second beta!\n\nFirst alpha!\n');
    assert.equal(found.filter((c) => c === 'ORDER_CHANGED:warning').length, 1);
    assert.equal(found.filter((c) => c === 'TEXT_MINOR_CHANGED:warning').length, 2);
    assert.equal(exitOf(html, 'Second beta!\n\nFirst alpha!\n', defaultOpts), 0);
  });

  it('a reversal among three edited blocks flags the blocks outside the longest run', () => {
    const h = '<main><p>One a.</p><p>Two b.</p><p>Three c.</p></main>';
    const found = codes(h, 'Three c!\n\nTwo b!\n\nOne a!\n');
    assert.equal(found.filter((c) => c === 'ORDER_CHANGED:warning').length, 2);
  });

  it('an edited block that moved past an exact one is flagged, and the exact one is not', () => {
    const report = check('<main><p>One a.</p><p>Fixed stays here.</p></main>', 'Fixed stays here.\n\nOne a!\n');
    const order = report.findings.filter((f) => f.code === 'ORDER_CHANGED');
    assert.equal(order.length, 1);
    assert.match(order[0]!.html?.excerpt ?? '', /One a/);
  });

  it('controls: edited blocks in order are not flagged, and exact moves are still reported once', () => {
    assert.deepEqual(codes(html, 'First alpha!\n\nSecond beta!\n'), ['TEXT_MINOR_CHANGED:warning', 'TEXT_MINOR_CHANGED:warning']);
    assert.deepEqual(codes(html, 'Second beta.\n\nFirst alpha.\n'), ['ORDER_CHANGED:warning']);
    assert.deepEqual(codes(html, 'First alpha.\n\nSecond beta.\n'), []);
  });
});

describe('0.2.22 follow-up F4: a self-closing left-out foreign element is a closed element', () => {
  it('a self-closing svg is skipped without a warning', () => {
    for (const tag of ['<svg/>', '<svg />', '<svg width="1" height="1"/>']) {
      const report = check('<main><p>A B</p></main>', `A ${tag} B\n`);
      assert.equal(report.summary.exitCode, 0, tag);
      assert.deepEqual(report.findings.map((f) => f.code), [], tag);
    }
  });

  it('identical raw markup with a trailing slash on a non-foreign tag passes on both sides', () => {
    for (const tag of ['button', 'script', 'template', 'iframe']) {
      const markup = `Before <${tag}/>Buy</${tag}> after`;
      assert.equal(exitOf(`<main><p>${markup}</p></main>`, `${markup}\n`), 0, tag);
    }
    // A nav closes an open paragraph in HTML, so it is compared with the markup directly inside the main.
    assert.equal(exitOf('<main>Before <nav/>Buy</nav> after</main>', 'Before <nav/>Buy</nav> after\n'), 0);
    const attr = 'Before <button data-x=a/>Buy</button> after';
    assert.equal(exitOf(`<main><p>${attr}</p></main>`, `${attr}\n`), 0);
  });

  it('controls: an unclosed button still warns, a closed pair is still skipped, and visible text still has to match', () => {
    const report = check('<main><p>A B</p></main>', 'A <button/>X B\n');
    assert.ok(report.findings.some((f) => f.code === 'MARKDOWN_INLINE_HTML_UNSUPPORTED' && /left-out inline <button>/.test(f.message)));
    assert.equal(exitOf('<main><p>A B</p></main>', 'A <button>X</button> B\n'), 0);
    assert.equal(exitOf('<main><p>A C</p></main>', 'A <svg/> B\n'), 1);
  });
});

describe('0.2.22 follow-up F5: no-break space and other space separators in code are whitespace', () => {
  const fence = (code: string) => '```\n' + code + '\n```\n';
  const nbsp = String.fromCharCode(0xa0);

  it('a no-break space against a plain space is CODE_WHITESPACE_CHANGED, a warning', () => {
    assert.deepEqual(codes('<main><pre>a&nbsp;b</pre></main>', fence('a b')), ['CODE_WHITESPACE_CHANGED:warning']);
    assert.deepEqual(codes(`<main><pre>a${nbsp}b</pre></main>`, fence('a b')), ['CODE_WHITESPACE_CHANGED:warning']);
    for (const cp of [0x2003, 0x202f, 0x3000]) {
      assert.deepEqual(codes(`<main><pre>a${String.fromCharCode(cp)}b</pre></main>`, fence('a b')), ['CODE_WHITESPACE_CHANGED:warning'], cp.toString(16));
    }
    assert.equal(exitOf('<main><pre>a&nbsp;b</pre></main>', fence('a b'), defaultOpts), 0);
  });

  it('controls: soft hyphen and zero width characters are still real differences', () => {
    for (const cp of [0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]) {
      const found = codes(`<main><pre>a${String.fromCharCode(cp)}b</pre></main>`, fence('ab'));
      assert.ok(!found.some((c) => c.startsWith('CODE_WHITESPACE_CHANGED')), cp.toString(16));
      assert.equal(exitOf(`<main><pre>a${String.fromCharCode(cp)}b</pre></main>`, fence('ab'), defaultOpts), 1, cp.toString(16));
    }
    for (const cp of [0xad, 0x200b]) {
      assert.deepEqual(codes(`<main><pre>a${String.fromCharCode(cp)}b</pre></main>`, fence('ab')), ['TEXT_CHANGED:error'], cp.toString(16));
    }
  });
});

describe('0.2.22 follow-up F6: a scheme-less credential in a rejected option value is not echoed', () => {
  const values = ['user:secret@example.com', 'u:pw@host.test/x?k=v'];
  const leak = /user|secret|u:pw|:pw|k=v/;

  it('parseCliArgs shows neither the user name nor the password', () => {
    for (const flag of ['--format', '--front-matter']) {
      for (const v of values) {
        let message = '';
        try {
          parseCliArgs([flag, v]);
        } catch (err) {
          if (!(err instanceof CliError)) throw err;
          message = err.message;
        }
        assert.match(message, /\(got "/);
        assert.doesNotMatch(message, leak, message);
        assert.match(message, /example\.com|host\.test/);
      }
    }
  });

  it('every shape with an at sign and no host is masked up to the last at sign', () => {
    const shapes = ['USR:SEC/RET@example.com', '://USR:SECRET@host', 'SEC/RET@host', 'USR:SEC?RET@host', 'USR:SEC#RET@host'];
    for (const v of shapes) {
      let message = '';
      try {
        parseCliArgs(['--format', v]);
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        message = err.message;
      }
      assert.doesNotMatch(message, /USR|SEC|RET/, v);
      assert.match(message, /\(got "\*\*\*@(example\.com|host)"\)/, v);
    }
  });

  it('controls: a plain value, a value without an at sign and a URL with a host keep their output', () => {
    assert.throws(() => parseCliArgs(['--format', 'xml']), /\(got "xml"\)/);
    assert.throws(() => parseCliArgs(['--format', 'a/b']), /\(got "a\/b"\)/);
    assert.throws(() => parseCliArgs(['--format', 'ftp://user:pw@example.test/?t=T']), (e: Error) => !/user|pw|=T/.test(e.message));
  });
});
