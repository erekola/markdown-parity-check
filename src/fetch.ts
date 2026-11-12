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
import { assertPublicHost, assertPublicResolved, BlockedAddressError, ipVersion } from './netguard.js';
import { maskUrl, redactText } from './normalize.js';
import { TOOL_NAME, TOOL_VERSION } from './version.js';

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
  // A bracketed IPv6 literal is an address and not a name (MP-20): it never goes to DNS, where the brackets made the
  // lookup a name lookup of a string that is no name. The policy runs on the literal itself before any connection.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const literal = hostname.slice(1, -1);
    if (ipVersion(literal) === 6) {
      if (!allowed) assertPublicResolved(hostname, literal);
      return { address: literal, family: 6 };
    }
  }
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

/** A decoder for an encoding label, or null when the runtime does not know the label. */
function decoderFor(label: string): InstanceType<typeof TextDecoder> | null {
  try {
    return new TextDecoder(label, { fatal: false });
  } catch {
    return null;
  }
}

function headerCharset(contentType: string | null): string | null {
  const m = /charset=([^;]+)/i.exec(contentType ?? '');
  return m?.[1] === undefined ? null : m[1].trim().replace(/^"|"$/g, '').toLowerCase();
}

/** The encoding a HTML page declares in a meta element among its first 1024 bytes (the HTML standard's prescan). A
 * comment is skipped, and a declared UTF-16 is read as UTF-8, because a page that can be read this far as ASCII is not
 * UTF-16. */
function metaCharset(buf: Buffer): string | null {
  const head = buf.subarray(0, 1024).toString('latin1').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const start = /<meta(?=[\s/>])/gi;
  for (let s = start.exec(head); s !== null; s = start.exec(head)) {
    const { attrs, end } = metaAttributes(head, s.index + s[0].length);
    start.lastIndex = end;
    let label: string | null = null;
    const direct = attrs.get('charset');
    if (direct !== undefined) label = direct.trim().toLowerCase();
    else if (attrs.get('http-equiv')?.trim().toLowerCase() === 'content-type') {
      const m = /charset\s*=\s*["']?\s*([^\s"'>;/]+)/i.exec(attrs.get('content') ?? '');
      if (m) label = m[1]!.toLowerCase();
    }
    if (label && decoderFor(label)) return label.startsWith('utf-16') ? 'utf-8' : label;
  }
  return null;
}

/** The attributes of one meta start tag, read the way the HTML standard's prescan reads them: a tag ends at a ">" that
 * is outside quotes, a name is matched exactly (so data-charset is not charset), and the first occurrence of a name
 * wins. A value whose closing quote is missing is dropped. `from` is the position right after "<meta". */
function metaAttributes(head: string, from: number): { attrs: Map<string, string>; end: number } {
  const attrs = new Map<string, string>();
  const n = head.length;
  let i = from;
  for (;;) {
    while (i < n && /[\s/]/.test(head[i]!)) i++;
    if (i >= n) return { attrs, end: n };
    if (head[i] === '>') return { attrs, end: i + 1 };
    let name = '';
    if (head[i] === '=') name += head[i++];
    while (i < n && !/[\s/>=]/.test(head[i]!)) name += head[i++];
    while (i < n && /\s/.test(head[i]!)) i++;
    let value = '';
    let complete = true;
    if (head[i] === '=') {
      i++;
      while (i < n && /\s/.test(head[i]!)) i++;
      const q = head[i];
      if (q === '"' || q === "'") {
        const close = head.indexOf(q, i + 1);
        if (close < 0) {
          value = head.slice(i + 1);
          complete = false;
          i = n;
        } else {
          value = head.slice(i + 1, close);
          i = close + 1;
        }
      } else {
        while (i < n && !/[\s>]/.test(head[i]!)) value += head[i++];
      }
    }
    const key = name.toLowerCase();
    if (complete && !attrs.has(key)) attrs.set(key, value);
  }
}

/** HTML is decoded the way the HTML standard orders the evidence: a byte order mark, then the charset of the
 * Content-Type header, then the meta declaration, and UTF-8 when none of them names an encoding the runtime knows
 * (MP-18). The standard's own default is windows-1252; UTF-8 is this tool's default for pages that say nothing. */
function decodeHtml(buf: Buffer, contentType: string | null): string {
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 'utf-8' : buf[0] === 0xff && buf[1] === 0xfe ? 'utf-16le' : buf[0] === 0xfe && buf[1] === 0xff ? 'utf-16be' : null;
  const fromBom = bom === null ? null : decoderFor(bom);
  if (fromBom) return fromBom.decode(buf);
  const header = headerCharset(contentType);
  const fromHeader = header === null ? null : decoderFor(header);
  if (fromHeader) return fromHeader.decode(buf);
  const meta = metaCharset(buf);
  const fromMeta = meta === null ? null : decoderFor(meta);
  return (fromMeta ?? new TextDecoder('utf-8')).decode(buf);
}

function decodeBody(buf: Buffer, contentType: string | null): string {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml') return decodeHtml(buf, contentType);
  const charset = headerCharset(contentType) ?? 'utf-8';
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
      // The header is the server's text: masked and cut before it goes into a message (0.2.12).
      throw new FetchError('protocol', '', `Unsupported Content-Encoding: ${redactText(String(encoding)).slice(0, 100)}`);
  }
}

/**
 * One wall-clock deadline for a whole fetchUrl call: DNS, connect, headers, body, decompression and every
 * redirect hop. When it fires, the active request, its response and its decompression stream are destroyed
 * and the pending step rejects.
 */
class Deadline {
  private timer: NodeJS.Timeout;
  private expired = false;
  private active: http.ClientRequest | null = null;
  private waiters = new Set<(err: FetchError) => void>();
  // Teardown callbacks of the response streams of the active hop. Destroying only the request leaves the
  // decompression stream decoding what it already received (a gzip bomb of about 64 KiB on the wire decodes to
  // 64 MiB, a brotli one to hundreds of MiB), so the streams are destroyed as well.
  private teardowns = new Set<() => void>();
  private readonly error: FetchError;

  constructor(url: string, timeoutMs: number) {
    this.error = new FetchError('timeout', url, `Timed out after ${timeoutMs} ms (whole fetch including DNS, redirects and body).`);
    this.timer = setTimeout(() => this.fire(), timeoutMs);
  }

  private fire(): void {
    this.expired = true;
    if (this.active) this.active.destroy(this.error);
    for (const t of this.teardowns) t();
    this.teardowns.clear();
    for (const w of this.waiters) w(this.error);
    this.waiters.clear();
  }

  /** Registers a callback that destroys the response streams of the active hop when the deadline fires.
   * Returns a function that removes it again. */
  onFire(teardown: () => void): () => void {
    if (this.expired) {
      teardown();
      return () => {};
    }
    this.teardowns.add(teardown);
    return () => {
      this.teardowns.delete(teardown);
    };
  }

  attach(req: http.ClientRequest): void {
    this.active = req;
    if (this.expired) req.destroy(this.error);
  }

  /** Forgets the request only if it is still the active one. The close event of a redirect hop fires after the
   * next hop was attached, so an unconditional reset left the next hop outside the deadline. */
  detach(req: http.ClientRequest): void {
    if (this.active === req) this.active = null;
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
          'User-Agent': options.userAgent ?? `${TOOL_NAME}/${TOOL_VERSION} (+local content comparison)`,
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
          // Close the connection at once. Up to 0.2.11 this path drained the body with res.resume(), and since neither
          // the byte count nor the deadline is attached here, a server that kept sending held the socket open and
          // reading after the fetch had already failed (found by an outside review 2026-09-26).
          res.destroy();
          req.destroy();
          reject(new FetchError('protocol', url.href, (err as Error).message));
          return;
        }
        // Destroys the decompression stream and the response and detaches the pipe between them, so nothing decodes
        // or reads on after the fetch has failed. No error is passed to destroy(), so neither stream emits one.
        const teardown = () => {
          if (dec) {
            res.unpipe(dec);
            dec.destroy();
          }
          res.destroy();
        };
        const unregister = deadline.onFire(teardown);
        if (dec) {
          stream = res.pipe(dec);
          dec.on('error', (err) => finish(new FetchError('protocol', url.href, `Decompression failed: ${err.message}`)));
          // A response that breaks off mid-body is a network failure; without this listener the error of the
          // source stream of a pipe is not handled by anything.
          res.on('error', (err) => finish(new FetchError('network', url.href, err.message)));
        }
        const finish = (err: Error | null) => {
          if (done) return;
          done = true;
          unregister();
          if (err) {
            teardown();
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
    req.on('close', () => deadline.detach(req));
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
