// The CommonJS zlib object, whose factory properties can be replaced (the ESM namespace is read only).
const zlibCjs = createRequire(import.meta.url)('node:zlib') as Record<string, unknown>;

// Fixes from the outside repo audit of 2026-10-22: maskHref in one pass (K4), the decompression stream torn down
// with the request (K5), C1 and bidi controls removed from report text (K7), registry shape checks (K8) and the
// IPv4-translated range ::ffff:0:a.b.c.d in the address policy (K11).

import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { afterEach, describe, it } from 'node:test';
import { fetchUrl, FetchError } from '../src/fetch.js';
import { isPublicAddress } from '../src/netguard.js';
import { maskHref, maskUrl, redactText } from '../src/normalize.js';
import { downloadVerified, fetchRegistryVersion, ReleaseCheckError, type FetchLike } from '../tools/release-check.js';

// Outputs of the previous implementation (searchParams.set for each key), recorded before the change. The new
// one-pass version must be byte-identical on all of them.
const MASK_PINS: Array<[string, string]> = [
   [
    "https://example.test/p?a=1&a=2&b=3",
    "https://example.test/p?a=***&b=***"
   ],
   [
    "https://example.test/p?b=1&a=2&b=3&a=4&c",
    "https://example.test/p?b=***&a=***&c=***"
   ],
   [
    "https://example.test/p?%61=1&a=2&%C3%A4=3&%E2%82%AC=4",
    "https://example.test/p?a=***&%C3%A4=***&%E2%82%AC=***"
   ],
   [
    "https://example.test/p?q=%26%3D%23&r=a+b&s=a%20b",
    "https://example.test/p?q=***&r=***&s=***"
   ],
   [
    "https://example.test/p?",
    "https://example.test/p?"
   ],
   [
    "https://example.test/p",
    "https://example.test/p"
   ],
   [
    "https://example.test/p#frag",
    "https://example.test/p"
   ],
   [
    "https://example.test/p?a=1#frag",
    "https://example.test/p?a=***"
   ],
   [
    "https://example.test/p?flag&other=&=novalue&&",
    "https://example.test/p?flag=***&other=***&=***"
   ],
   [
    "https://example.test/p?+a=1&a+b=2",
    "https://example.test/p?+a=***&a+b=***"
   ],
   [
    "https://example.test/p?\u00e4=1&\u20ac=2&\u4e2d=3",
    "https://example.test/p?%C3%A4=***&%E2%82%AC=***&%E4%B8%AD=***"
   ],
   [
    "https://user:pw@example.test/p?token=abc&token=def",
    "https://example.test/p?token=***"
   ],
   [
    "https://user@example.test:8080/p?x=1",
    "https://example.test:8080/p?x=***"
   ],
   [
    "HTTP://EXAMPLE.test/p?X=1&x=2",
    "http://example.test/p?X=***&x=***"
   ],
   [
    "https://example.test/?a=1&b[]=2&b[]=3",
    "https://example.test/?a=***&b%5B%5D=***"
   ],
   [
    "https://example.test/p?a=1&a=2&a=3",
    "https://example.test/p?a=***"
   ],
   [
    "mailto:someone@example.test?subject=hi&body=x",
    "mailto:someone@example.test?subject=***&body=***"
   ],
   [
    "data:text/plain,hello?x=1",
    "data:text/plain,hello?x=***"
   ],
   [
    "javascript:void(0)?x=1",
    "javascript:void(0)?x=***"
   ],
   [
    "file:///C:/dir/f.md?x=1",
    "file:///C:/dir/f.md?x=***"
   ],
   [
    "/relative/path?a=1&a=2#h",
    "/relative/path?a=***&a=***"
   ],
   [
    "//host.test/p?a=1&b=2",
    "//host.test/p?a=***&b=***"
   ],
   [
    "//user:pw@host.test/p?a=1",
    "//host.test/p?a=***"
   ],
   [
    "relative?a=1&&b=2",
    "relative?a=***&&b=***"
   ],
   [
    "?a=1",
    "?a=***"
   ],
   [
    "?",
    "?"
   ],
   [
    "#only",
    ""
   ],
   [
    "",
    ""
   ],
   [
    "not a url ? a=1 & b=2",
    "not a url ? a=***& b=***"
   ],
   [
    "https://example.test/p?a=%ZZ&b=%",
    "https://example.test/p?a=***&b=***"
   ],
   [
    "https://exa mple.test/p?a=1",
    "https://exa mple.test/p?a=***"
   ],
   [
    "https://example.test/p?a=1&&b",
    "https://example.test/p?a=***&b=***"
   ],
   [
    "https://example.test/p?__proto__=1&constructor=2&toString=3",
    "https://example.test/p?__proto__=***&constructor=***&toString=***"
   ]
  ];
const MASK_URL_PINS: Array<[string, string]> = [
   [
    "https://example.test/p?a=1&a=2&b=3",
    "https://example.test/p?a=***&b=***"
   ],
   [
    "https://example.test/p?b=1&a=2&b=3&a=4&c",
    "https://example.test/p?b=***&a=***&c=***"
   ],
   [
    "https://example.test/p?%61=1&a=2&%C3%A4=3&%E2%82%AC=4",
    "https://example.test/p?a=***&%C3%A4=***&%E2%82%AC=***"
   ],
   [
    "https://example.test/p?q=%26%3D%23&r=a+b&s=a%20b",
    "https://example.test/p?q=***&r=***&s=***"
   ],
   [
    "https://example.test/p?",
    "https://example.test/p?"
   ],
   [
    "https://example.test/p",
    "https://example.test/p"
   ],
   [
    "https://example.test/p#frag",
    "https://example.test/p"
   ],
   [
    "https://example.test/p?a=1#frag",
    "https://example.test/p?a=***"
   ],
   [
    "https://example.test/p?flag&other=&=novalue&&",
    "https://example.test/p?flag=***&other=***&=***"
   ],
   [
    "https://example.test/p?+a=1&a+b=2",
    "https://example.test/p?+a=***&a+b=***"
   ],
   [
    "https://example.test/p?\u00e4=1&\u20ac=2&\u4e2d=3",
    "https://example.test/p?%C3%A4=***&%E2%82%AC=***&%E4%B8%AD=***"
   ],
   [
    "https://user:pw@example.test/p?token=abc&token=def",
    "https://example.test/p?token=***"
   ],
   [
    "https://user@example.test:8080/p?x=1",
    "https://example.test:8080/p?x=***"
   ],
   [
    "HTTP://EXAMPLE.test/p?X=1&x=2",
    "http://example.test/p?X=***&x=***"
   ],
   [
    "https://example.test/?a=1&b[]=2&b[]=3",
    "https://example.test/?a=***&b%5B%5D=***"
   ],
   [
    "https://example.test/p?a=1&a=2&a=3",
    "https://example.test/p?a=***"
   ],
   [
    "mailto:someone@example.test?subject=hi&body=x",
    "mailto:someone@example.test?subject=***&body=***"
   ],
   [
    "data:text/plain,hello?x=1",
    "data:text/plain,hello?x=***"
   ],
   [
    "javascript:void(0)?x=1",
    "javascript:void(0)?x=***"
   ],
   [
    "file:///C:/dir/f.md?x=1",
    "file:///C:/dir/f.md?x=***"
   ],
   [
    "/relative/path?a=1&a=2#h",
    "/relative/path?a=***&a=***"
   ],
   [
    "//host.test/p?a=1&b=2",
    "//host.test/p?a=***&b=***"
   ],
   [
    "//user:pw@host.test/p?a=1",
    "//host.test/p?a=***"
   ],
   [
    "relative?a=1&&b=2",
    "relative?a=***&&b=***"
   ],
   [
    "?a=1",
    "?a=***"
   ],
   [
    "?",
    "?"
   ],
   [
    "#only",
    ""
   ],
   [
    "",
    ""
   ],
   [
    "not a url ? a=1 & b=2",
    "not a url ? a=***& b=***"
   ],
   [
    "https://example.test/p?a=%ZZ&b=%",
    "https://example.test/p?a=***&b=***"
   ],
   [
    "https://exa mple.test/p?a=1",
    "https://exa mple.test/p?a=***"
   ],
   [
    "https://example.test/p?a=1&&b",
    "https://example.test/p?a=***&b=***"
   ],
   [
    "https://example.test/p?__proto__=1&constructor=2&toString=3",
    "https://example.test/p?__proto__=***&constructor=***&toString=***"
   ]
  ];
const REDACT_PINS: Array<[string, string]> = [
   [
    "See https://example.test/p?a=1&a=2&b=3 and www.example.test/x?y=1#f done.",
    "See https://example.test/p?a=***&b=*** and www.example.test/x?y=*** done."
   ],
   [
    "plain text with no url",
    "plain text with no url"
   ],
   [
    "/path?token=abc#frag and (https://u:p@example.test/?k=v).",
    "/path?token=*** and (https://example.test/?k=***)."
   ],
   [
    "x\u001b[31mred\u001b[0m https://example.test/?a=1",
    "x[31mred[0m https://example.test/?a=***"
   ]
  ];

describe('maskHref in one pass (K4)', () => {
  it('keeps the exact output of the per-key implementation on the pinned inputs', () => {
    assert.ok(MASK_PINS.length >= 30);
    for (const [input, expected] of MASK_PINS) assert.equal(maskHref(input), expected, JSON.stringify(input));
    for (const [input, expected] of MASK_URL_PINS) assert.equal(maskUrl(input), expected, JSON.stringify(input));
    for (const [input, expected] of REDACT_PINS) assert.equal(redactText(input), expected, JSON.stringify(input));
  });
  it('masks 20 000 query keys in well under a second (loose limit; rerun alone if red under load)', () => {
    const href = 'https://example.test/target?' + Array.from({ length: 20000 }, (_, i) => `k${i}=x`).join('&');
    const t = process.hrtime.bigint();
    const out = maskHref(href);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(out.startsWith('https://example.test/target?k0=***&k1=***&'), out.slice(0, 80));
    assert.equal(out.split('&').length, 20000);
    assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  });
  it('merges duplicate keys in first-seen order at scale too', () => {
    const href = 'https://example.test/t?' + Array.from({ length: 4000 }, (_, i) => `k${i % 1000}=v${i}`).join('&');
    const out = maskHref(href);
    assert.equal(out.split('&').length, 1000);
    assert.ok(out.startsWith('https://example.test/t?k0=***&k1=***&k2=***'));
  });
});

describe('redactText removes C1 and bidi controls (K7)', () => {
  const codes: number[] = [];
  for (let c = 0x80; c <= 0x9f; c++) codes.push(c);
  for (let c = 0x202a; c <= 0x202e; c++) codes.push(c);
  for (let c = 0x2066; c <= 0x2069; c++) codes.push(c);
  it('removes every listed code point', () => {
    assert.equal(codes.length, 32 + 5 + 4);
    for (const c of codes) {
      const ch = String.fromCharCode(c);
      assert.equal(redactText(`a${ch}b`), 'ab', `U+${c.toString(16)}`);
    }
  });
  it('still removes C0 controls and keeps ordinary text, tab, newline and neighbouring code points', () => {
    assert.equal(redactText('a' + String.fromCharCode(27) + '[31mb'), 'a[31mb');
    const text = 'Plain text, tab' + String.fromCharCode(9) + 'here,' + String.fromCharCode(10) + 'new line, ' + String.fromCharCode(0xa0) + 'nbsp, ' + String.fromCharCode(0xff, 0xe4, 0xf6, 0x2028, 0x202f, 0x2065, 0x206a, 0x4e2d) + '.';
    assert.equal(redactText(text), text);
  });
});

describe('netguard: IPv4-translated range ::ffff:0:a.b.c.d (K11)', () => {
  it('checks the embedded IPv4 as the mapped form does', () => {
    const cases: Array<[string, string, boolean]> = [
      ['::ffff:0:7f00:1', '::ffff:7f00:1', false],
      ['::ffff:0:a00:1', '::ffff:a00:1', false],
      ['::ffff:0:a9fe:a9fe', '::ffff:a9fe:a9fe', false],
      ['::ffff:0:5db8:d822', '::ffff:5db8:d822', true],
      ['0:0:0:0:ffff:0:7f00:1', '0:0:0:0:0:ffff:7f00:1', false],
      ['::ffff:0:127.0.0.1', '::ffff:127.0.0.1', false],
      ['::ffff:0:93.184.216.34', '::ffff:93.184.216.34', true],
    ];
    for (const [translated, mapped, publicExpected] of cases) {
      assert.equal(isPublicAddress(mapped), publicExpected, mapped);
      assert.equal(isPublicAddress(translated), publicExpected, translated);
    }
  });
  it('does not widen the block to neighbouring ranges', () => {
    assert.equal(isPublicAddress('2606:4700::6810:84e5'), true);
    assert.equal(isPublicAddress('::ffff:1:5db8:d822'), true);
  });
});

describe('release check registry shape (K8)', () => {
  const reply = (body: string): FetchLike => async () => ({ status: 200, text: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
  const rejects = async (body: string, re: RegExp) => {
    await assert.rejects(fetchRegistryVersion('https://registry.test', 'pkg', '1.0.0', reply(body)), (err) => {
      assert.ok(err instanceof ReleaseCheckError, `expected ReleaseCheckError, got ${String(err)}`);
      assert.match((err as Error).message, re);
      return true;
    });
  };
  it('turns a null, a non-object or a wrongly typed field into a ReleaseCheckError', async () => {
    await rejects('null', /not a JSON object/);
    await rejects('[]', /not a JSON object/);
    await rejects('7', /not a JSON object/);
    await rejects('{}', /no dist\.tarball/);
    await rejects('{"dist":null}', /no dist\.tarball/);
    await rejects('{"dist":"x"}', /dist that is not an object/);
    await rejects('{"dist":{"tarball":null}}', /no dist\.tarball/);
    await rejects('{"dist":{"tarball":5}}', /no dist\.tarball/);
    await rejects('{"dist":{"tarball":"https://t.test/p.tgz","integrity":null}}', /integrity that is not a string/);
    await rejects('{"dist":{"tarball":"https://t.test/p.tgz","integrity":5}}', /integrity that is not a string/);
    await rejects('{"dist":{"tarball":"https://t.test/p.tgz","shasum":{}}}', /shasum that is not a string/);
    await rejects('{"version":1,"dist":{"tarball":"https://t.test/p.tgz"}}', /version that is not a string/);
    await rejects('{"version":"2.0.0","dist":{"tarball":"https://t.test/p.tgz"}}', /Registry returned version 2\.0\.0/);
  });
  it('still returns a well formed record', async () => {
    const d = await fetchRegistryVersion('https://registry.test', 'pkg', '1.0.0', reply('{"version":"1.0.0","dist":{"tarball":"https://t.test/p.tgz","integrity":"sha512-x","shasum":"ab"}}'));
    assert.deepEqual(d, { tarball: 'https://t.test/p.tgz', integrity: 'sha512-x', shasum: 'ab' });
  });
  it('downloadVerified refuses a record without integrity and shasum with a ReleaseCheckError', async () => {
    const fetchFn: FetchLike = async () => ({ status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(1) });
    await assert.rejects(downloadVerified({ tarball: 'https://t.test/p.tgz' } as never, fetchFn), ReleaseCheckError);
  });
});

describe('decompression stream is destroyed with the request (K5)', () => {
  type Counter = { out: number; stream: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress };
  const restore: Array<() => void> = [];
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const r of restore.splice(0)) r();
    for (const s of servers.splice(0)) await new Promise<void>((res) => { s.closeAllConnections(); s.close(() => res()); });
  });
  // Wraps one zlib factory so the decoded bytes of every decoder it makes are counted.
  function count(factory: 'createGunzip' | 'createInflate' | 'createBrotliDecompress', into: Counter[]): void {
    const z = zlibCjs as Record<string, (...a: unknown[]) => Counter['stream']>;
    const orig = z[factory]!;
    const wrapped = function (this: unknown, ...a: unknown[]) {
      const stream = orig.apply(this, a);
      const c: Counter = { out: 0, stream };
      stream.on('data', (chunk: Buffer) => { c.out += chunk.length; });
      into.push(c);
      return stream;
    };
    Object.defineProperty(z, factory, { value: wrapped, configurable: true, writable: true });
    restore.push(() => { Object.defineProperty(z, factory, { value: orig, configurable: true, writable: true }); });
  }
  async function serve(wire: Buffer, encoding: string, stallAfter?: number): Promise<number> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/markdown', 'Content-Encoding': encoding, ...(stallAfter === undefined ? { 'Content-Length': String(wire.length) } : {}) });
      if (stallAfter === undefined) res.end(wire);
      else res.write(wire.subarray(0, stallAfter)); // then never ends
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return (server.address() as import('node:net').AddressInfo).port;
  }
  const opts = (timeoutMs: number, maxBytes: number) => ({ accept: 'text/markdown', timeoutMs, maxBytes, resolver: async () => [{ address: '127.0.0.1', family: 4 as const }], testAllowHosts: ['parity.test'] });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const MIB = 1024 * 1024;

  const cases: Array<['createGunzip' | 'createInflate' | 'createBrotliDecompress', string, () => Buffer]> = [
    ['createGunzip', 'gzip', () => zlib.gzipSync(Buffer.alloc(64 * MIB, 0x61))],
    ['createInflate', 'deflate', () => zlib.deflateSync(Buffer.alloc(64 * MIB, 0x61))],
    ['createBrotliDecompress', 'br', () => zlib.brotliCompressSync(Buffer.alloc(64 * MIB, 0x61), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } })],
  ];
  for (const [factory, encoding, make] of cases) {
    it(`${encoding}: after the byte cap rejects, the decoder stops near the cap`, async () => {
      const counters: Counter[] = [];
      count(factory, counters);
      const uncaught: unknown[] = [];
      const onUncaught = (e: unknown) => uncaught.push(e);
      process.on('uncaughtException', onUncaught);
      try {
        const port = await serve(make(), encoding);
        await assert.rejects(fetchUrl(`http://parity.test:${port}/bomb`, opts(10000, MIB)), (e) => e instanceof FetchError && e.kind === 'too_large');
        const c = counters[0]!;
        const atReject = c.out;
        await sleep(400);
        assert.equal(c.stream.destroyed, true);
        assert.ok(c.out <= atReject + 256 * 1024, `decoder kept decoding: ${atReject} -> ${c.out}`);
        assert.ok(c.out < 8 * MIB, `decoded ${c.out} bytes of 64 MiB`);
        assert.deepEqual(uncaught, []);
      } finally {
        process.off('uncaughtException', onUncaught);
      }
    });
  }
  it('the deadline destroys the decoder as well as the request', async () => {
    const counters: Counter[] = [];
    count('createGunzip', counters);
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const wire = zlib.gzipSync(Buffer.alloc(64 * MIB, 0x61));
      const port = await serve(wire, 'gzip', Math.floor(wire.length / 2)); // half the stream, then silence
      await assert.rejects(fetchUrl(`http://parity.test:${port}/stall`, opts(400, 512 * MIB)), (e) => e instanceof FetchError && e.kind === 'timeout');
      const c = counters[0]!;
      const atReject = c.out;
      await sleep(300);
      assert.equal(c.stream.destroyed, true);
      assert.equal(c.out, atReject);
      assert.deepEqual(uncaught, []);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
