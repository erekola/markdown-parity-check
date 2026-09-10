// Bounded HTTP(S) fetch for the URL mode. Only the given URL and its redirects are fetched, never a site
// crawl. The address policy in netguard.ts is applied to the URL host, to every DNS answer and to every
// redirect target, and the validated address is handed to the socket through a custom lookup so that a
// separate re-resolution cannot bypass the check (DNS rebinding).

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import type { LookupFunction } from 'node:net';
import { assertPublicHost, assertPublicResolved, BlockedAddressError } from './netguard.js';
import { maskUrl } from './normalize.js';

export type FetchErrorKind = 'invalid_url' | 'blocked' | 'timeout' | 'too_large' | 'redirect_loop' | 'too_many_redirects' | 'network' | 'protocol';

export class FetchError extends Error {
  kind: FetchErrorKind;
  url: string;
  constructor(kind: FetchErrorKind, url: string, message: string) {
    super(message);
    this.name = 'FetchError';
    this.kind = kind;
    this.url = maskUrl(url);
  }
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export interface FetchOptions {
  accept: string;
  timeoutMs: number;
  /** Cap on decoded (decompressed) body bytes. */
  maxBytes: number;
  maxRedirects?: number;
  userAgent?: string;
  /** Injectable resolver for tests. Defaults to dns.lookup with all addresses. */
  resolver?: Resolver;
  /**
   * Test harness only: exact host names whose address policy check is skipped, so that a loopback
   * test server can be reached. Not reachable from the CLI; the production default is an empty list.
   */
  testAllowHosts?: string[];
  /** Test harness only: agent for TLS tests. */
  agent?: http.Agent | https.Agent;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  body: string;
  /** Decoded body size in bytes. */
  bytes: number;
  redirects: number;
  accept: string;
}

const defaultResolver: Resolver = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
};

export function validateUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new FetchError('invalid_url', input, `Not a valid absolute URL: ${maskUrl(input)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new FetchError('protocol', input, `Only http and https URLs are fetched (got ${u.protocol}).`);
  }
  if (u.username !== '' || u.password !== '') {
    throw new FetchError('invalid_url', input, 'URLs with embedded credentials are refused.');
  }
  return u;
}

async function pickAddress(hostname: string, options: FetchOptions): Promise<{ address: string; family: 4 | 6 }> {
  const allowed = (options.testAllowHosts ?? []).includes(hostname.toLowerCase());
  if (!allowed) assertPublicHost(hostname);
  const resolver = options.resolver ?? defaultResolver;
  let answers: Array<{ address: string; family: 4 | 6 }>;
  try {
    answers = await resolver(hostname);
  } catch (err) {
    throw new FetchError('network', hostname, `DNS lookup failed for ${hostname}: ${(err as Error).message}`);
  }
  if (answers.length === 0) throw new FetchError('network', hostname, `DNS lookup returned no address for ${hostname}.`);
  if (!allowed) {
    // Every answer must be public: an attacker who controls the name can otherwise mix answers.
    for (const a of answers) assertPublicResolved(hostname, a.address);
  }
  return answers[0]!;
}

function decodeBody(buf: Buffer, contentType: string | null): string {
  const m = /charset=([^;]+)/i.exec(contentType ?? '');
  const charset = (m?.[1] ?? 'utf-8').trim().replace(/^"|"$/g, '').toLowerCase();
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function decompressor(encoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    case '':
    case 'identity':
      return null;
    default:
      throw new FetchError('protocol', '', `Unsupported Content-Encoding: ${encoding}`);
  }
}

/**
 * One wall-clock deadline for a whole fetchUrl call: DNS, connect, headers, body, decompression and every
 * redirect hop. When it fires, the active request is destroyed and the pending step rejects.
 */
class Deadline {
  private timer: NodeJS.Timeout;
  private expired = false;
  private active: http.ClientRequest | null = null;
  private waiters = new Set<(err: FetchError) => void>();
  private readonly error: FetchError;

  constructor(url: string, timeoutMs: number) {
    this.error = new FetchError('timeout', url, `Timed out after ${timeoutMs} ms (whole fetch including DNS, redirects and body).`);
    this.timer = setTimeout(() => this.fire(), timeoutMs);
  }

  private fire(): void {
    this.expired = true;
    if (this.active) this.active.destroy(this.error);
    for (const w of this.waiters) w(this.error);
    this.waiters.clear();
  }

  attach(req: http.ClientRequest): void {
    this.active = req;
    if (this.expired) req.destroy(this.error);
  }

  detach(): void {
    this.active = null;
  }

  /** Races a promise against the deadline. */
  race<T>(p: Promise<T>): Promise<T> {
    if (this.expired) return Promise.reject(this.error);
    return new Promise<T>((resolve, reject) => {
      const waiter = (err: FetchError) => reject(err);
      this.waiters.add(waiter);
      p.then(
        (v) => {
          this.waiters.delete(waiter);
          resolve(v);
        },
        (e) => {
          this.waiters.delete(waiter);
          reject(this.expired ? this.error : e);
        },
      );
    });
  }

  close(): void {
    clearTimeout(this.timer);
  }
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  bytes: number;
}

function requestOnce(url: URL, address: { address: string; family: 4 | 6 }, options: FetchOptions, deadline: Deadline): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const lookup: LookupFunction = (_hostname, opts, cb) => {
      // Hand the validated address to the socket; no second DNS resolution takes place. Node may ask
      // for all addresses (autoSelectFamily); answer with the single validated one in either shape.
      const callback = cb as unknown as (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
      if ((opts as { all?: boolean }).all) callback(null, [{ address: address.address, family: address.family }]);
      else callback(null, address.address, address.family);
    };
    const req = lib.request(
      url,
      {
        method: 'GET',
        lookup,
        agent: options.agent ?? false,
        headers: {
          Accept: options.accept,
          'Accept-Encoding': 'gzip, deflate, br',
          'User-Agent': options.userAgent ?? 'markdown-parity-check/0.1 (+local content comparison)',
        },
        // Explicit default: TLS verification is never disabled.
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let done = false;
        let stream: Readable = res;
        let dec: ReturnType<typeof decompressor>;
        try {
          dec = decompressor(res.headers['content-encoding']);
        } catch (err) {
          res.resume();
          reject(new FetchError('protocol', url.href, (err as Error).message));
          return;
        }
        if (dec) {
          stream = res.pipe(dec);
          dec.on('error', (err) => finish(new FetchError('protocol', url.href, `Decompression failed: ${err.message}`)));
        }
        const finish = (err: Error | null) => {
          if (done) return;
          done = true;
          if (err) {
            req.destroy();
            reject(err);
          } else {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), bytes });
          }
        };
        stream.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > options.maxBytes) {
            finish(new FetchError('too_large', url.href, `Response body exceeded --max-bytes (${options.maxBytes} bytes of decoded content).`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => finish(null));
        stream.on('error', (err) => finish(new FetchError('network', url.href, err.message)));
      },
    );
    req.on('error', (err) => {
      if (err instanceof FetchError) reject(err);
      else reject(new FetchError('network', url.href, err.message));
    });
    req.on('close', () => deadline.detach());
    deadline.attach(req);
    req.end();
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetches one URL with the given Accept header, following at most maxRedirects redirects. Every hop is
 * validated by the address policy. Returns the decoded body; the raw response is not stored.
 */
export async function fetchUrl(input: string, options: FetchOptions): Promise<FetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const deadline = new Deadline(input, options.timeoutMs);
  try {
    return await fetchWithDeadline(input, options, maxRedirects, deadline);
  } finally {
    deadline.close();
  }
}

async function fetchWithDeadline(input: string, options: FetchOptions, maxRedirects: number, deadline: Deadline): Promise<FetchResult> {
  let url = validateUrl(input);
  const visited = new Set<string>();
  let redirects = 0;
  for (;;) {
    if (visited.has(url.href)) throw new FetchError('redirect_loop', url.href, `Redirect loop detected at ${maskUrl(url.href)}.`);
    visited.add(url.href);
    let address: { address: string; family: 4 | 6 };
    try {
      address = await deadline.race(pickAddress(url.hostname, options));
    } catch (err) {
      if (err instanceof BlockedAddressError) throw new FetchError('blocked', url.href, err.message);
      throw err;
    }
    const res = await deadline.race(requestOnce(url, address, options, deadline));
    if (REDIRECT_STATUSES.has(res.status)) {
      const loc = res.headers['location'];
      if (!loc) throw new FetchError('protocol', url.href, `HTTP ${res.status} without a Location header.`);
      if (redirects >= maxRedirects) throw new FetchError('too_many_redirects', url.href, `More than ${maxRedirects} redirects.`);
      let next: URL;
      try {
        next = new URL(loc, url);
      } catch {
        throw new FetchError('protocol', url.href, `Invalid redirect target: ${maskUrl(loc)}`);
      }
      url = validateUrl(next.href);
      redirects++;
      continue;
    }
    const ct = res.headers['content-type'] ?? null;
    return {
      requestedUrl: input,
      finalUrl: url.href,
      status: res.status,
      contentType: ct,
      body: decodeBody(res.body, ct),
      bytes: res.bytes,
      redirects,
      accept: options.accept,
    };
  }
}
