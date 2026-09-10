// Text normalization. Strict normalization preserves case and content characters; loose normalization is
// used only as an alignment aid.

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
    // Map typographic quotes and dashes to plain forms for alignment only.
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Code content: normalize line endings and strip a trailing newline only. */
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
const URL_IN_TEXT = /(?:[a-z][a-z0-9+.-]*:\/\/[^\s<>"'()]+|www\.[^\s<>"'()]+|(?<![\w/])\/[^\s<>"'()]*[?#][^\s<>"'()]*|[^\s<>"'()]*\?[\w%.-]+=[^\s<>"'()]*)/giu;

/** Masks query values and fragments of every URL-like run in a piece of report text. */
export function redactText(text: string): string {
  return text.replace(URL_IN_TEXT, (m) => {
    // Keep trailing sentence punctuation outside the URL.
    const trail = /[.,;:!?]+$/.exec(m)?.[0] ?? '';
    const core = m.slice(0, m.length - trail.length);
    return maskHref(core) + trail;
  });
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
