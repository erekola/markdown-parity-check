// Address policy for the URL mode: only public unicast addresses are fetched. The check runs on the
// URL host, on every DNS answer and on every redirect target, and the checked address is the one the
// socket connects to (see fetch.ts).

import { isIP } from 'node:net';

export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPublicIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  for (const [base, bits] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0)) return false;
  }
  return true;
}

/** Expands an IPv6 address into 8 16-bit groups. Returns null when it cannot be parsed. */
export function expandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // Embedded IPv4 tail, for example ::ffff:127.0.0.1.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    s = s.slice(0, -v4[1]!.length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

export function isPublicIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const allZeroTo = (k: number) => g.slice(0, k).every((x) => x === 0);
  if (allZeroTo(8)) return false; // ::
  if (allZeroTo(7) && g7 === 1) return false; // ::1
  if (allZeroTo(5) && g5 === 0xffff) return isPublicIPv4(v4FromGroups(g6, g7)); // ::ffff:a.b.c.d
  if (allZeroTo(6)) return isPublicIPv4(v4FromGroups(g6, g7)); // ::a.b.c.d (deprecated compatible)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPublicIPv4(v4FromGroups(g6, g7)); // 64:ff9b::/96 NAT64
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return false; // 64:ff9b:1::/48 local NAT64
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((g0 & 0xffc0) === 0xfec0) return false; // fec0::/10 site local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2001 && g1 === 0) return isPublicIPv4(v4FromGroups(g6 ^ 0xffff, g7 ^ 0xffff)); // Teredo: check the embedded client address
  if (g0 === 0x2002) return isPublicIPv4(v4FromGroups(g1, g2)); // 6to4
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // 100::/64 discard
  return true;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPublicIPv4(ip);
  if (v === 6) return isPublicIPv6(ip);
  return false;
}

/** Throws when the host name itself is a non-public literal or a local name. */
export function assertPublicHost(hostname: string): void {
  let h = hostname.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa') || h === '') {
    throw new BlockedAddressError(`Host "${hostname}" is a local name and is not fetched.`);
  }
  if (isIP(h) && !isPublicAddress(h)) {
    throw new BlockedAddressError(`Address ${h} is not a public address and is not fetched.`);
  }
}

export function assertPublicResolved(hostname: string, address: string): void {
  if (!isPublicAddress(address)) {
    throw new BlockedAddressError(`Host "${hostname}" resolves to ${address}, which is not a public address and is not fetched.`);
  }
}
