// Text normalization. Strict normalization preserves case, applies NFC, removes the characters in ZERO_WIDTH,
// maps the spaces in NBSP to a plain space and collapses whitespace. Loose normalization aligns blocks and
// classifies minor text differences (TEXT_MINOR_CHANGED).

const NBSP = /[\u00a0\u2007\u202f]/g;
const WS = /[ \t\r\n\f\v]+/g;
const ZERO_WIDTH = /[\u200b-\u200d\ufeff\u00ad]/g;

export function strictNormalize(text: string): string {
  return text
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .replace(NBSP, ' ')
    .replace(WS, ' ')
    .trim();
}

export function looseNormalize(text: string): string {
  return strictNormalize(text)
    .toLowerCase()
    // Map typographic quotes and dashes to plain forms, for alignment and for classifying minor text differences.
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Code content: CRLF and CR line endings become LF and every trailing newline is removed; other whitespace is kept. */
export function normalizeCode(code: string): string {
  return code.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

// A numeric token: optional sign (ASCII hyphen, Unicode minus or plus) that is not preceded by a letter
// or digit (so the "-09" in 2026-09-10 is a separator, not a sign), digits with inner separators
// (decimal, thousands, date, time, version), optional percent or currency sign on either side.
const NUMBER_RE = /(?<![\p{L}\p{N}])(?:[€$£]\s?)?[-\u2212+]?\d+(?:[.,:\/\-\u2010-\u2015\u2212]\d+)*\s?(?:%|€|\$|£)?/gu;

/** Extracts numeric tokens (prices, percentages, dates, versions, signed values) in source order. */
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    // Dash variants (hyphen, en dash, em dash, Unicode minus) are one separator or sign character.
    out.push(m[0].replace(/\s+/g, '').replace(/[\u2010-\u2015\u2212]/g, '-'));
  }
  return out;
}

/** Report excerpt: URLs inside the text are masked BEFORE truncation, so a cut query value cannot leak. */
export function excerpt(text: string, max = 80): string {
  const t = redactText(strictNormalize(text));
  return t.length <= max ? t : t.slice(0, max - 1) + '\u2026';
}

// URL-like runs inside free text: absolute URLs, www. hosts, and root-relative paths that carry a query
// or fragment. Only the query values and the fragment are rewritten; other text is left untouched.
//
// Up to 0.2.1 this was one regular expression, kept in test/linear.test.ts as the reference. Its time was
// quadratic in the length of a run without whitespace (CodeQL js/polynomial-redos; 80 000 characters took
// 4.2 s), and the text comes from the compared page. Every alternative of that expression ends where the
// run of characters other than whitespace and < > " ' ( ) ends, so a run holds at most one match, and the
// match starts at the leftmost position where any alternative can start. urlStart finds that position
// with a few linear scans of the run, and the test compares the two on random input.
const RUN = /[^\s<>"'()]+/gu;
const TRAIL = '.,;:!?';

// Character tests with the old expression's i and u flags, under which \w and [a-z] also match U+017F and
// U+212A, because they case-fold to s and k.
const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x17f || c === 0x212a;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isWord = (c: number) => isLetter(c) || isDigit(c) || c === 0x5f;
const isSchemeChar = (c: number) => isLetter(c) || isDigit(c) || c === 0x2b || c === 0x2e || c === 0x2d; // [a-z0-9+.-]
const isParamChar = (c: number) => isWord(c) || c === 0x25 || c === 0x2e || c === 0x2d; // [\w%.-]
const isW = (c: number) => c === 0x57 || c === 0x77;

/** Start of the URL-like match in the run t[s, e), or -1 when the run holds none. */
function urlStart(t: string, s: number, e: number): number {
  // [^\s<>"'()]*\?[\w%.-]+=  A query parameter anywhere in the run makes the whole run the match.
  for (let q = s; q < e; q++) {
    if (t.charCodeAt(q) !== 0x3f) continue;
    let k = q + 1;
    while (k < e && isParamChar(t.charCodeAt(k))) k++;
    if (k > q + 1 && k < e && t.charCodeAt(k) === 0x3d) return s;
    q = k - 1;
  }
  let best = -1;
  // [a-z][a-z0-9+.-]*:\/\/[^\s<>"'()]+  The first letter of a scheme run that is followed by :// and at
  // least one more character.
  for (let j = s; j < e; ) {
    if (!isSchemeChar(t.charCodeAt(j))) {
      j++;
      continue;
    }
    let letter = -1;
    let b = j;
    while (b < e && isSchemeChar(t.charCodeAt(b))) {
      if (letter < 0 && isLetter(t.charCodeAt(b))) letter = b;
      b++;
    }
    if (letter >= 0 && b + 3 < e && t.startsWith('://', b)) {
      best = letter;
      break;
    }
    j = b;
  }
  // www\.[^\s<>"'()]+
  for (let p = s; p + 4 < e && (best < 0 || p < best); p++) {
    if (isW(t.charCodeAt(p)) && isW(t.charCodeAt(p + 1)) && isW(t.charCodeAt(p + 2)) && t.charCodeAt(p + 3) === 0x2e) {
      best = p;
      break;
    }
  }
  // (?<![\w/])\/[^\s<>"'()]*[?#][^\s<>"'()]*  The first '/' that does not follow a word character or '/',
  // when a '?' or '#' comes after it in the run.
  let lastQueryOrHash = -1;
  for (let r = e - 1; r > s; r--) {
    const c = t.charCodeAt(r);
    if (c === 0x3f || c === 0x23) {
      lastQueryOrHash = r;
      break;
    }
  }
  for (let p = s; p < lastQueryOrHash && (best < 0 || p < best); p++) {
    if (t.charCodeAt(p) !== 0x2f) continue;
    const before = p > 0 ? t.charCodeAt(p - 1) : -1;
    if (before === 0x2f || isWord(before)) continue;
    best = p;
    break;
  }
  return best;
}

/** Masks query values and fragments of every URL-like run in a piece of report text. */
export function redactText(text: string): string {
  let out = '';
  let done = 0;
  for (const run of text.matchAll(RUN)) {
    const s = run.index!;
    const e = s + run[0].length;
    const p = urlStart(text, s, e);
    if (p < 0) continue;
    // Keep trailing sentence punctuation outside the URL.
    let end = e;
    while (end > p && TRAIL.includes(text[end - 1]!)) end--;
    out += text.slice(done, p) + maskHref(text.slice(p, end)) + text.slice(end, e);
    done = e;
  }
  return out + text.slice(done);
}

/** Resolves a possibly relative href against a base. Returns null when it cannot be resolved. */
export function resolveHref(rawHref: string, base: string | null): string | null {
  const href = rawHref.trim();
  if (href === '') return null;
  if (base) {
    try {
      return new URL(href, base).href;
    } catch {
      return null;
    }
  }
  try {
    return new URL(href).href; // absolute already
  } catch {
    return null;
  }
}

/** Masks query values and drops the fragment for display in reports and logs. Never returns the raw
 * query of an unparseable input either. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of Array.from(u.searchParams.keys())) u.searchParams.set(key, '***');
    u.hash = '';
    return u.href;
  } catch {
    return maskHref(url);
  }
}

/** Masks query values and drops the fragment of an absolute or relative href for display. */
export function maskHref(href: string): string {
  try {
    const u = new URL(href);
    for (const key of Array.from(u.searchParams.keys())) u.searchParams.set(key, '***');
    u.hash = '';
    return u.href;
  } catch {
    // Relative or unparseable: mask by hand.
    const hashAt = href.indexOf('#');
    let h = hashAt >= 0 ? href.slice(0, hashAt) : href;
    const q = h.indexOf('?');
    if (q >= 0) {
      const params = h.slice(q + 1).split('&').map((kv) => (kv === '' ? kv : `${kv.split('=')[0]}=***`));
      h = `${h.slice(0, q)}?${params.join('&')}`;
    }
    return h;
  }
}

/** Describes how two hrefs differ without revealing masked parts. */
export function hrefDifference(a: string, b: string): string {
  const parse = (h: string) => {
    try {
      const u = new URL(h, 'http://relative.invalid/');
      return { path: `${u.origin}${u.pathname}`, query: u.search, hash: u.hash };
    } catch {
      return { path: h, query: '', hash: '' };
    }
  };
  const x = parse(a);
  const y = parse(b);
  const parts: string[] = [];
  if (x.path !== y.path) parts.push('path or host');
  if (x.query !== y.query) parts.push('query');
  if (x.hash !== y.hash) parts.push('fragment');
  return parts.length ? parts.join(', ') : 'nothing visible';
}

export type HrefRelation = 'same' | 'different' | 'uncertain';

/**
 * The string the URL parser actually reads (WHATWG URL, basic URL parser): leading and trailing C0 controls
 * and spaces are removed, and so is every ASCII tab and newline wherever it is. ".\t./guide" is "../guide" to
 * the parser, so counting ".." segments in the raw text found none where the parser climbs one (found by an
 * outside review, 2026-09-12).
 */
function urlParserInput(href: string): string {
  let start = 0;
  let end = href.length;
  while (start < end && href.charCodeAt(start) <= 0x20) start++;
  while (end > start && href.charCodeAt(end - 1) <= 0x20) end--;
  return href.slice(start, end).replace(/[\t\n\r]/g, '');
}

/**
 * How two references relate when neither could be resolved, which is the case for two relative
 * links and no base URL. A textual difference alone does not make two targets different: ./guide
 * and guide are the same address under every base. Both references are first reduced to the string the URL
 * parser reads (urlParserInput), so the segment counts and the kinds below describe what is resolved.
 *
 * 'same': the two resolve equal under synthetic bases that cover every way a base takes part in
 * resolution, so they are equal under any http or https base, which is the kind of base a web page has. The bases are two origins with different schemes, and
 * for each, two sets of names that share none (directory segment, file and query), each used as a
 * directory, a file and a file with a query, all deeper than any ".." segment in either reference. Two
 * name sets are needed because a reference that climbs above its start and descends again, such as
 * ../d//.., reuses the base's own segment names: under one set it can equal a different reference
 * (found by an independent property test 2026-09-12 before 0.2.6 was released).
 * 'different': the difference cannot depend on the base, because both are network-path references,
 * both are absolute-path references, or both are relative-path references with a non-empty path and
 * no ".." segment. 'uncertain': anything else, because some base could make the two meet
 * (../guide and guide are equal at the root, ?q and ./?q under a directory base).
 */
export function relativeHrefRelation(a: string, b: string): HrefRelation {
  const x = urlParserInput(a);
  const y = urlParserInput(b);
  if (x === y) return 'same';
  const pathOf = (h: string) => h.replace(/\\/g, '/').split(/[?#]/, 1)[0] ?? '';
  const dotDots = (h: string) => pathOf(h).split('/').filter((s) => /^(?:\.|%2e){2}$/i.test(s)).length;
  const depth = Math.max(dotDots(x), dotDots(y)) + 1;
  const bases: string[] = [];
  for (const origin of ['https://base.invalid/', 'http://other.invalid/']) {
    for (const [segment, file, query] of [['d', 'f', '?q'], ['e', 'g', '?r']] as const) {
      const dir = origin + `${segment}/`.repeat(depth);
      bases.push(dir, dir + file, dir + file + query);
    }
  }
  const resolveAll = (h: string): string | null => {
    try {
      return bases.map((base) => new URL(h, base).href).join(' ');
    } catch {
      return null;
    }
  };
  const rx = resolveAll(x);
  const ry = resolveAll(y);
  if (rx === null || ry === null) return 'different';
  if (rx === ry) return 'same';
  const kind = (h: string) => {
    const p = h.replace(/\\/g, '/');
    if (p.startsWith('//')) return 'network';
    if (p.startsWith('/')) return 'absolute';
    return pathOf(h) !== '' && dotDots(h) === 0 ? 'relative' : 'base-dependent';
  };
  const kx = kind(x);
  return kx !== 'base-dependent' && kx === kind(y) ? 'different' : 'uncertain';
}
