// Secrets in URLs must not reach a report, stderr or an error object (0.2.10). An outside review on 2026-09-22
// found two ways they did: the URL masking kept the user name and the password, also in the error of a URL that
// was refused for carrying them, and a numeric query value came back as a changed number, because numbers were
// read from the text before the URLs in it were masked. Every value below is synthetic.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { compare } from '../src/compare.js';
import { FetchError, validateUrl } from '../src/fetch.js';
import type { Extraction } from '../src/model.js';
import { extractNumbers, hideUrlSecrets, looseNormalize, maskHref, maskUrl, redactText, visibleNumbers } from '../src/normalize.js';
import { renderJson } from '../src/report.js';
import { CLI, ROOT } from './helpers.js';

const PASSWORD = 'SYNTHETICPASSWORDNOTREAL';
const USER = 'syntheticuser';
const TOKEN = '924681357024681357';
const OTHER_TOKEN = '135792468013579246';

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

let tmp: string;
before(() => {
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  tmp = fs.mkdtempSync(path.join(ROOT, '.tmp', 'secrets-'));
});
after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // A sandbox without delete permission leaves the temp folder behind; that is not a test failure.
  }
});

function pair(name: string, html: string, md: string): string[] {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'page.html'), `<!doctype html><html><body><main>${html}</main></body></html>`);
  fs.writeFileSync(path.join(dir, 'page.md'), md);
  return ['--html-file', path.join(dir, 'page.html'), '--markdown-file', path.join(dir, 'page.md')];
}

describe('user information in URLs (0.2.10)', () => {
  it('maskUrl and maskHref drop the user name and the password and keep host and path', () => {
    const url = `https://${USER}:${PASSWORD}@example.com/path?token=${TOKEN}#fragment`;
    for (const f of [maskUrl, maskHref]) {
      const out = f(url);
      assert.equal(out, 'https://example.com/path?token=***');
      assert.doesNotMatch(out, new RegExp(`${PASSWORD}|${USER}|${TOKEN}`));
    }
    assert.equal(maskUrl(`https://${USER}@example.com/`), 'https://example.com/');
  });

  it('protocol-relative, backslashed and unparseable forms lose their user information too', () => {
    const cases: Array<[string, string]> = [
      [`//${USER}:${PASSWORD}@example.com/p?k=1`, '//example.com/p?k=***'],
      [`https://${USER}:${PASSWORD}@exa mple.com/p?k=1#x`, 'https://***@exa mple.com/p?k=***'],
      [`https://${USER}:${PASSWORD}@[::1/p`, 'https://***@[::1/p'],
      [`${String.fromCharCode(92, 92)}${USER}:${PASSWORD}@example.com/p`, `${String.fromCharCode(92, 92)}example.com/p`],
      [`/\t/${USER}:${PASSWORD}@ex ample.com/p`, '//***@ex ample.com/p'],
      [`//a:b@c:${PASSWORD}@host/p`, '//host/p'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(maskHref(input), expected, JSON.stringify(input));
      assert.doesNotMatch(maskUrl(input), new RegExp(PASSWORD), JSON.stringify(input));
    }
  });

  it('an address without user information is unchanged, and an @ in the path is not user information', () => {
    assert.equal(maskHref('//example.com/@user/post'), '//example.com/@user/post');
    assert.equal(maskHref('https://example.com/@user/post'), 'https://example.com/@user/post');
    assert.equal(maskHref('/docs/page'), '/docs/page');
    assert.equal(maskHref('guide@2x.png'), 'guide@2x.png');
    assert.equal(maskHref('mailto:someone@example.com'), 'mailto:someone@example.com');
  });

  it('redactText masks user information in free text, with and without a scheme', () => {
    for (const text of [
      `See https://${USER}:${PASSWORD}@example.com/x for details.`,
      `See //${USER}:${PASSWORD}@example.com/x for details.`,
      `(//${USER}:${PASSWORD}@example.com)`,
    ]) {
      const out = redactText(text);
      assert.doesNotMatch(out, new RegExp(`${PASSWORD}|${USER}`), text);
      assert.match(out, /example\.com/, text);
    }
    assert.equal(redactText('a //example.com/@user/post and me@example.com'), 'a //example.com/@user/post and me@example.com');
  });

  it('the refused URL, its error and the FetchError url carry no credentials, and it stays refused', () => {
    const url = `https://${USER}:${PASSWORD}@example.com/path?token=${TOKEN}`;
    let error: unknown;
    try {
      validateUrl(url);
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof FetchError);
    assert.equal(error.kind, 'invalid_url');
    assert.match(error.message, /credentials are refused/);
    assert.equal(error.url, 'https://example.com/path?token=***');
    const unparseable = new FetchError('invalid_url', `https://${USER}:${PASSWORD}@exa mple.com/`, 'x');
    assert.doesNotMatch(unparseable.url, new RegExp(PASSWORD));
  });

  it('the CLI refuses a credential URL and repeats nothing of it, in text and in JSON', () => {
    for (const format of ['text', 'json']) {
      const r = cli(['--url', `https://${USER}:${PASSWORD}@example.com/p?token=${TOKEN}`, '--format', format]);
      assert.equal(r.code, 2);
      assert.match(r.err, /credentials are refused/);
      assert.doesNotMatch(r.out + r.err, new RegExp(`${PASSWORD}|${USER}|${TOKEN}`));
    }
  });

  it('a --base-url with credentials leaves no trace in either format, through the whole parse', () => {
    const args = pair('base', '<p>Read <a href="guide/a">the guide</a>.</p>', 'Read [the guide](guide/b).\n');
    for (const format of ['text', 'json']) {
      const r = cli([...args, '--base-url', `https://${USER}:${PASSWORD}@example.com/docs/`, '--format', format]);
      assert.equal(r.code, 1, r.err);
      assert.match(r.out, /LINK_TARGET_CHANGED/);
      assert.match(r.out, /example\.com\/docs\/guide\/a/);
      assert.doesNotMatch(r.out + r.err, new RegExp(`${PASSWORD}|${USER}`));
    }
  });
});

describe('numbers inside masked URL parts (0.2.10)', () => {
  it('hideUrlSecrets takes out query values, the fragment and user information and nothing else', () => {
    assert.equal(hideUrlSecrets(`at https://example.com:8443/v2/view?token=${TOKEN}&page=3#s-4, ok`), 'at https://example.com:8443/v2/view?token=&page=, ok');
    assert.equal(hideUrlSecrets(`at //1:${TOKEN}@example.com/5 or /x?id=${TOKEN}.`), 'at //example.com/5 or /x?id=.');
    assert.equal(hideUrlSecrets('Price 10 € from 2026-09-22, 3.5 %'), 'Price 10 € from 2026-09-22, 3.5 %');
  });

  it('visibleNumbers keeps prices, dates, ports and path numbers and drops the hidden ones', () => {
    const text = `Pay 10 € by 2026-09-22 at https://example.com:8443/docs/2/view?token=${TOKEN}#p-7`;
    assert.deepEqual(extractNumbers(text), ['10€', '2026-09-22', '8443', '2', TOKEN, '7']);
    assert.deepEqual(visibleNumbers(text), ['10€', '2026-09-22', '8443', '2']);
  });

  const block = (text: string) => ({ type: 'paragraph' as const, text, loose: looseNormalize(text), links: [], numbers: extractNumbers(text), location: { line: 1, blockIndex: 0 } });
  const extraction = (text: string): Extraction => ({ blocks: [block(text)], strategy: 'synthetic paragraph', confidence: 'high', notes: [], issues: [] });

  it('a numeric token that differs only inside a query value stays NUMBER_CHANGED and is not shown', () => {
    const r = compare(extraction(`Open the private report at https://example.com/view?token=${TOKEN}`), extraction(`Open the private report at https://example.com/view?token=${OTHER_TOKEN}`));
    assert.deepEqual(r.findings.map((f) => [f.code, f.severity]), [['NUMBER_CHANGED', 'error']]);
    assert.match(r.findings[0]!.message, /masked part of a URL/);
    assert.equal(r.findings[0]!.before, undefined);
    const json = renderJson({ findings: r.findings } as never);
    assert.doesNotMatch(json, new RegExp(`${TOKEN}|${OTHER_TOKEN}`));
  });

  it('a price change next to a hidden token is reported with the prices and without the token', () => {
    const r = compare(extraction(`Price 10 € at https://example.com/view?token=${TOKEN}`), extraction(`Price 12 € at https://example.com/view?token=${TOKEN}`));
    const f = r.findings.find((x) => x.code === 'NUMBER_CHANGED')!;
    assert.equal(f.before, '10€');
    assert.equal(f.after, '12€');
    assert.doesNotMatch(renderJson({ findings: r.findings } as never), new RegExp(TOKEN));
  });

  it('through the whole parse and the real CLI, the token is in no field of either format', () => {
    const args = pair(
      'token',
      `<p>Open the private result report at https://example.com/view?token=${TOKEN} for 10 €.</p><p>The yearly price of the private result report is 10 € for one site.</p>`,
      `Open the private result report at https://example.com/view?token=${OTHER_TOKEN} for 10 €.\n\nThe yearly price of the private result report is 12 € for one site.\n`,
    );
    for (const format of ['text', 'json']) {
      const r = cli([...args, '--format', format]);
      assert.equal(r.code, 1, r.err);
      assert.doesNotMatch(r.out + r.err, new RegExp(`${TOKEN}|${OTHER_TOKEN}`));
      // The control: the price change in the page text is still reported with its values.
      assert.match(r.out, /10€/);
      assert.match(r.out, /12€/);
    }
    const report = JSON.parse(cli([...args, '--format', 'json']).out);
    const codes = report.findings.map((f: { code: string }) => f.code);
    assert.equal(codes.filter((c: string) => c === 'NUMBER_CHANGED').length, 2);
  });
});

describe('the independent review of 0.2.10 before release', () => {
  it('a slash inside the password does not stop the masking of an unparseable address', () => {
    const url = `https://admin:${PASSWORD}/tail@internal.example/path?k=${TOKEN}`;
    for (const out of [maskHref(url), maskUrl(url), redactText(`see ${url} now`)]) {
      assert.doesNotMatch(out, new RegExp(`${PASSWORD}|admin|${TOKEN}`), out);
      assert.match(out, /internal\.example\/path/, out);
    }
    let error: unknown;
    try {
      validateUrl(url);
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof FetchError);
    assert.doesNotMatch(`${error.url} ${error.message}`, new RegExp(PASSWORD));
    const r = cli(['--url', url]);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.out + r.err, new RegExp(PASSWORD));
  });

  it('a backslashed authority in free text is masked without a query too', () => {
    const b = String.fromCharCode(92);
    const text = `Backslash form https:${b}${b}${USER}:${PASSWORD}@host.example${b}path here.`;
    const out = redactText(text);
    assert.doesNotMatch(out, new RegExp(`${PASSWORD}|${USER}`), out);
    assert.match(out, /host\.example/, out);
  });

  it('a parseable address with an @ in its path keeps its path', () => {
    assert.equal(maskHref('//example.com/@user/post?x=1'), '//example.com/@user/post?x=***');
    assert.equal(redactText('at //example.com/@user/post and //cdn.example/a@2x.png'), 'at //example.com/@user/post and //cdn.example/a@2x.png');
  });
});

describe('the second and third review of 0.2.10 before release', () => {
  it('a refused address hides everything up to its last @ behind a visible mask, and never guesses', () => {
    const cases: Array<[string, string]> = [
      ['https://example.com:99999/a@2x.png', 'https://***@2x.png'],
      ['//example.com:99999/a@2x.png?k=1', '//***@2x.png?k=***'],
      ['https://example.com:abc/a@2x.png', 'https://***@2x.png'],
      [`https://admin:${PASSWORD}/tail@internal.example/a@2x.png`, 'https://***@2x.png'],
      [`https://ad min:1234/tail@internal.example/x`, 'https://***@internal.example/x'],
      [`https://admin:se/c@${PASSWORD}@internal.example/x`, 'https://***@internal.example/x'],
    ];
    for (const [input, expected] of cases) assert.equal(maskHref(input), expected, input);
  });

  it('a refused address without an @ and every parseable address keep host and path', () => {
    assert.equal(maskHref('https://example.com:99999/a.png?k=1'), 'https://example.com:99999/a.png?k=***');
    assert.equal(maskHref('https://example.com/a@2x.png'), 'https://example.com/a@2x.png');
    assert.equal(maskHref('//cdn.example/a@2x.png'), '//cdn.example/a@2x.png');
  });
});
