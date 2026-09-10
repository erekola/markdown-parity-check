import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fetchUrl, FetchError, validateUrl } from '../src/fetch.js';
import { isPublicAddress, assertPublicHost } from '../src/netguard.js';
import { startHarness, type Harness, MD_PAGE } from './harness.js';

async function expectFetchError(p: Promise<unknown>, kind: string, re?: RegExp): Promise<FetchError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof FetchError, `expected FetchError, got ${String(err)}`);
    assert.equal(err.kind, kind, err.message);
    if (re) assert.match(err.message, re);
    return err;
  }
  assert.fail('expected a FetchError');
}

describe('address policy (netguard)', () => {
  it('classifies IPv4 ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '11.0.0.1', '104.16.0.1']) assert.equal(isPublicAddress(ip), true, ip);
  });
  it('classifies IPv6 forms including mapped, NAT64, 6to4 and Teredo embeddings', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:0:0:0:0:0:80ff:fffe', '2001:db8::1', 'fe80::1%eth0', '::127.0.0.1']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['2606:4700::6810:84e5', '2a00:1450:4001:80b::200e', '::ffff:93.184.216.34', '64:ff9b::5db8:d822', '2002:5db8:d822::1']) assert.equal(isPublicAddress(ip), true, ip);
  });
  it('refuses local names and IP literals in URLs', () => {
    for (const h of ['localhost', 'foo.localhost', 'printer.local', 'db.internal', '127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '10.0.0.1']) {
      assert.throws(() => assertPublicHost(h), /not fetched/, h);
    }
    assert.doesNotThrow(() => assertPublicHost('example.com'));
  });
  it('validateUrl refuses non-http schemes and credentials', () => {
    assert.throws(() => validateUrl('file:///etc/passwd'), /Only http and https/);
    assert.throws(() => validateUrl('ftp://example.com/x'), /Only http and https/);
    assert.throws(() => validateUrl('http://user:pw@example.com/'), /credentials/);
    assert.throws(() => validateUrl('not a url'), /Not a valid absolute URL/);
    // The WHATWG parser normalizes exotic IPv4 spellings; the policy sees the canonical form.
    assert.equal(validateUrl('http://0x7f.1/').hostname, '127.0.0.1');
    assert.equal(validateUrl('http://2130706433/').hostname, '127.0.0.1');
  });
});

describe('fetchUrl against a loopback harness', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.close();
  });

  it('fetches with the given Accept header and reports status and content type', async () => {
    const r = await fetchUrl(h.url('/ok'), h.options('text/markdown'));
    assert.equal(r.status, 200);
    assert.equal(r.contentType, 'text/markdown; charset=utf-8');
    assert.equal(r.body, MD_PAGE);
    assert.equal(r.redirects, 0);
    assert.equal(r.bytes, Buffer.byteLength(MD_PAGE));
    const html = await fetchUrl(h.url('/ok'), h.options('text/html'));
    assert.match(html.contentType ?? '', /text\/html/);
  });
  it('binds the validated address to the socket: parity.test has no real DNS and still reaches the harness', async () => {
    const r = await fetchUrl(h.url('/ok'), h.options('text/html'));
    assert.equal(r.status, 200);
  });
  it('decompresses gzip and counts decoded bytes', async () => {
    const r = await fetchUrl(h.url('/gzip'), h.options('text/markdown'));
    assert.equal(r.body, MD_PAGE);
    assert.equal(r.bytes, Buffer.byteLength(MD_PAGE));
  });
  it('enforces the byte cap on decoded content, with and without Content-Length', async () => {
    await expectFetchError(fetchUrl(h.url('/big'), h.options('text/markdown', { maxBytes: 100 * 1024 })), 'too_large');
    await expectFetchError(fetchUrl(h.url('/big-gzip'), h.options('text/markdown', { maxBytes: 1024 * 1024 })), 'too_large', /decoded/);
  });
  it('times out on a silent server, on a trickling body and on slow DNS, as one whole-fetch deadline', async () => {
    await expectFetchError(fetchUrl(h.url('/slow'), h.options('text/html', { timeoutMs: 300 })), 'timeout');
    let t0 = Date.now();
    await expectFetchError(fetchUrl(h.url('/trickle'), h.options('text/markdown', { timeoutMs: 100 })), 'timeout', /whole fetch/);
    assert.ok(Date.now() - t0 < 350, `trickle took ${Date.now() - t0} ms`);
    t0 = Date.now();
    await expectFetchError(fetchUrl('http://slow-dns.test/', h.options('text/html', { timeoutMs: 50 })), 'timeout');
    assert.ok(Date.now() - t0 < 350, `slow DNS took ${Date.now() - t0} ms`);
    // A fast fetch under the same option still succeeds and leaves no timer running.
    const ok = await fetchUrl(h.url('/ok'), h.options('text/markdown', { timeoutMs: 2000 }));
    assert.equal(ok.status, 200);
  });
  it('follows a redirect and reports the final URL, refuses loops and long chains', async () => {
    const r = await fetchUrl(h.url('/redirect-ok'), h.options('text/markdown'));
    assert.equal(r.finalUrl, h.url('/ok'));
    assert.equal(r.redirects, 1);
    await expectFetchError(fetchUrl(h.url('/loop'), h.options('text/html')), 'redirect_loop');
    await expectFetchError(fetchUrl(h.url('/many?n=0'), h.options('text/html')), 'too_many_redirects');
  });
  it('blocks non-public targets directly, via DNS and via redirects, for IPv4 and IPv6', async () => {
    await expectFetchError(fetchUrl('http://127.0.0.1/', h.options('text/html')), 'blocked');
    await expectFetchError(fetchUrl('http://[::1]/', h.options('text/html')), 'blocked');
    await expectFetchError(fetchUrl('http://[::ffff:127.0.0.1]/', h.options('text/html')), 'blocked');
    await expectFetchError(fetchUrl('http://0x7f.0.0.1/', h.options('text/html')), 'blocked');
    await expectFetchError(fetchUrl('http://localhost/', h.options('text/html')), 'blocked');
    await expectFetchError(fetchUrl('http://169.254.169.254/latest/meta-data/', h.options('text/html')), 'blocked');
    await expectFetchError(fetchUrl('http://private-name.test/', h.options('text/html')), 'blocked', /resolves to 192\.168\.1\.10/);
    await expectFetchError(fetchUrl('http://mixed-name.test/', h.options('text/html')), 'blocked', /127\.0\.0\.1/);
    await expectFetchError(fetchUrl('http://v6-loopback.test/', h.options('text/html')), 'blocked');
    await expectFetchError(fetchUrl('http://v6-mapped.test/', h.options('text/html')), 'blocked');
    await expectFetchError(fetchUrl(h.url('/to-private'), h.options('text/html')), 'blocked', /10\.0\.0\.1/);
    await expectFetchError(fetchUrl(h.url('/to-loopback-name'), h.options('text/html')), 'blocked', /localhost/);
    await expectFetchError(fetchUrl(h.url('/to-file'), h.options('text/html')), 'protocol');
    await expectFetchError(fetchUrl(h.url('/to-creds'), h.options('text/html')), 'invalid_url');
  });
  it('the production default has no allowed test hosts: the harness itself is blocked without the option', async () => {
    const opts = h.options('text/html');
    delete opts.testAllowHosts;
    await expectFetchError(fetchUrl(h.url('/ok'), opts), 'blocked', /resolves to 127\.0\.0\.1/);
  });
  it('a public name that does not answer is a network error, not a crash', async () => {
    const err = await expectFetchError(fetchUrl('http://unknown-name.test/', h.options('text/html')), 'network');
    assert.match(err.message, /DNS lookup failed/);
  });
  it('masks query values even in unparseable URLs and redirect targets', async () => {
    const err = await expectFetchError(fetchUrl('https://ex ample.com/p?token=SYNTHETIC-SECRET#f', h.options('text/html')), 'invalid_url');
    assert.doesNotMatch(err.message + err.url, /SYNTHETIC-SECRET|#f/);
    assert.match(err.message, /token=\*\*\*/);
  });
  it('masks query values in error URLs', async () => {
    const err = await expectFetchError(fetchUrl('http://127.0.0.1/p?token=secret#frag', h.options('text/html')), 'blocked');
    assert.equal(err.url, 'http://127.0.0.1/p?token=***');
  });
});
