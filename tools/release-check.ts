// Release gate (audit finding P2-2, 2026-09-10): the tarball that goes to npm and the tarball attached
// to the GitHub release must be the same package. This tool compares a locally packed tarball with the
// version on the registry and never treats a network or registry error as "the version is missing".
//
// Usage (from the repository root, after npm run build):
//   node dist/tools/release-check.js --tarball <file.tgz> --name <pkg> --version <x.y.z> [--registry <url>] [--save <path>]
// Exit codes:
//   0   the version exists on the registry, its integrity matches and its content equals the local tarball
//   10  the version does not exist on the registry (HTTP 404); the local tarball may be published
//   1   mismatch, wrong integrity, or a registry or network error
// With --save, the registry tarball is written to <path> once verified, for use as the release asset.

import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

export const EXIT_VERIFIED = 0;
export const EXIT_MISSING = 10;
export const EXIT_MISMATCH = 1;

export class ReleaseCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseCheckError';
  }
}

export interface RegistryVersion {
  tarball: string;
  integrity?: string;
  shasum?: string;
}

export interface TarEntry {
  name: string;
  mode: number;
  size: number;
  type: string;
  content: Buffer;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;

export function sha512Integrity(buf: Buffer): string {
  return `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
}

export function sha1Hex(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** Reads a gzipped ustar/pax archive into entries with their content. Only regular files are returned. */
export function readTarball(gz: Buffer): TarEntry[] {
  const tar = zlib.gunzipSync(gz);
  const entries: TarEntry[] = [];
  let offset = 0;
  let paxPath: string | undefined;
  const str = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');
  const octal = (b: Buffer) => parseInt(str(b).trim() || '0', 8);
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((x) => x === 0)) break;
    let name = str(header.subarray(0, 100));
    const prefix = str(header.subarray(345, 500));
    if (prefix) name = `${prefix}/${name}`;
    const mode = octal(header.subarray(100, 108)) & 0o777;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]!) || '0';
    const start = offset + 512;
    const content = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      // pax extended header: records "<len> <key>=<value>\n"
      const text = content.toString('utf8');
      for (const line of text.split('\n')) {
        const m = /^\d+ path=(.*)$/.exec(line);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (type === 'L') {
      // GNU long name: the content is the name of the next entry.
      paxPath = str(content);
      continue;
    }
    if (type === 'g' || type === 'K') continue;
    const entryName = paxPath ?? name;
    paxPath = undefined;
    if (type === '0' || type === '\0') entries.push({ name: entryName, mode, size, type: '0', content: Buffer.from(content) });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/** Compares two package tarballs. Byte-identical archives match at once; otherwise the full entry list,
 * every file's bytes and the executable bit are compared and every difference is listed. */
export function compareTarballs(local: Buffer, remote: Buffer): string[] {
  if (local.equals(remote)) return [];
  const a = readTarball(local);
  const b = readTarball(remote);
  const diffs: string[] = [];
  const namesA = new Set(a.map((e) => e.name));
  const namesB = new Set(b.map((e) => e.name));
  for (const n of namesA) if (!namesB.has(n)) diffs.push(`only in local tarball: ${n}`);
  for (const n of namesB) if (!namesA.has(n)) diffs.push(`only in registry tarball: ${n}`);
  const byName = new Map(b.map((e) => [e.name, e]));
  for (const e of a) {
    const r = byName.get(e.name);
    if (!r) continue;
    if (!e.content.equals(r.content)) diffs.push(`content differs: ${e.name} (${e.size} vs ${r.size} bytes)`);
    if ((e.mode & 0o111) !== (r.mode & 0o111)) diffs.push(`executable bit differs: ${e.name} (${e.mode.toString(8)} vs ${r.mode.toString(8)})`);
  }
  if (diffs.length === 0) diffs.push('archives differ in bytes but not in file list, content or executable bits; treating the difference as a mismatch because it was not identified');
  return diffs;
}

/** Fetches the registry record of one version. Returns null only for an explicit HTTP 404. */
export async function fetchRegistryVersion(registry: string, name: string, version: string, fetchFn: FetchLike): Promise<RegistryVersion | null> {
  // A scoped name keeps its leading @ and encodes the rest; the registry accepts @scope%2Fname.
  const encodedName = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  const base = registry.endsWith('/') ? registry.slice(0, -1) : registry;
  const url = `${base}/${encodedName}/${encodeURIComponent(version)}`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new ReleaseCheckError(`Registry request failed for ${url}: ${(err as Error).message}`);
  }
  if (res.status === 404) return null;
  if (res.status !== 200) throw new ReleaseCheckError(`Registry returned HTTP ${res.status} for ${url}; not treating this as a missing version.`);
  let data: { dist?: RegistryVersion; version?: string };
  try {
    data = JSON.parse(await res.text()) as { dist?: RegistryVersion; version?: string };
  } catch (err) {
    throw new ReleaseCheckError(`Registry response for ${url} is not JSON: ${(err as Error).message}`);
  }
  if (!data.dist?.tarball) throw new ReleaseCheckError(`Registry response for ${url} has no dist.tarball.`);
  if (data.version !== undefined && data.version !== version) throw new ReleaseCheckError(`Registry returned version ${data.version} for ${url}.`);
  return data.dist;
}

export async function downloadVerified(dist: RegistryVersion, fetchFn: FetchLike): Promise<Buffer> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(dist.tarball);
  } catch (err) {
    throw new ReleaseCheckError(`Tarball download failed for ${dist.tarball}: ${(err as Error).message}`);
  }
  if (res.status !== 200) throw new ReleaseCheckError(`Tarball download returned HTTP ${res.status} for ${dist.tarball}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!dist.integrity && !dist.shasum) throw new ReleaseCheckError('Registry record has neither dist.integrity nor dist.shasum; cannot verify the tarball.');
  if (dist.integrity) {
    if (!dist.integrity.startsWith('sha512-')) throw new ReleaseCheckError(`Unsupported integrity algorithm in ${dist.integrity.split('-')[0]}; expected sha512.`);
    const actual = sha512Integrity(buf);
    if (actual !== dist.integrity) throw new ReleaseCheckError(`Registry tarball integrity mismatch: dist.integrity ${dist.integrity}, downloaded ${actual}.`);
  }
  if (dist.shasum && sha1Hex(buf) !== dist.shasum) throw new ReleaseCheckError(`Registry tarball shasum mismatch: dist.shasum ${dist.shasum}, downloaded ${sha1Hex(buf)}.`);
  return buf;
}

export interface CheckResult {
  code: 0 | 10 | 1;
  message: string;
  registryTarball?: Buffer;
}

export async function checkRelease(opts: { tarball: Buffer; name: string; version: string; registry: string; fetchFn: FetchLike }): Promise<CheckResult> {
  const dist = await fetchRegistryVersion(opts.registry, opts.name, opts.version, opts.fetchFn);
  if (dist === null) return { code: EXIT_MISSING, message: `${opts.name}@${opts.version} is not on the registry (HTTP 404); the local tarball may be published.` };
  const remote = await downloadVerified(dist, opts.fetchFn);
  const diffs = compareTarballs(opts.tarball, remote);
  if (diffs.length > 0) {
    return { code: EXIT_MISMATCH, message: `${opts.name}@${opts.version} on the registry differs from the local tarball:\n  ${diffs.join('\n  ')}` };
  }
  const identical = opts.tarball.equals(remote) ? 'byte-identical' : 'equal in file list, content and executable bits';
  return { code: EXIT_VERIFIED, message: `${opts.name}@${opts.version} verified: registry integrity ${dist.integrity ?? dist.shasum} matches and the tarball is ${identical} to the local one.`, registryTarball: remote };
}

function arg(argv: string[], key: string): string | undefined {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[], fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<number> {
  const tarballPath = arg(argv, '--tarball');
  const name = arg(argv, '--name');
  const version = arg(argv, '--version');
  const registry = arg(argv, '--registry') ?? 'https://registry.npmjs.org';
  const save = arg(argv, '--save');
  if (!tarballPath || !name || !version) {
    process.stderr.write('Usage: release-check --tarball <file.tgz> --name <pkg> --version <x.y.z> [--registry <url>] [--save <path>]\n');
    return EXIT_MISMATCH;
  }
  try {
    const result = await checkRelease({ tarball: fs.readFileSync(tarballPath), name, version, registry, fetchFn });
    process.stdout.write(`${result.message}\n`);
    if (result.code === EXIT_VERIFIED && save && result.registryTarball) {
      fs.writeFileSync(save, result.registryTarball);
      process.stdout.write(`Registry tarball saved to ${save} (${result.registryTarball.length} bytes).\n`);
    }
    return result.code;
  } catch (err) {
    process.stderr.write(`release-check: ${(err as Error).message}\n`);
    return EXIT_MISMATCH;
  }
}

if (process.argv[1] && /release-check\.js$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
