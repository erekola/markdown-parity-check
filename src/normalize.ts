// Text normalization. Strict normalization preserves case, applies NFC, removes the characters in ZERO_WIDTH,
// maps the spaces in NBSP to a plain space and collapses whitespace. Loose normalization aligns blocks. The text key
// (textKey) classifies minor text differences (TEXT_MINOR_CHANGED): it keeps the marks and symbols that loose
// normalization drops, so a changed mark or symbol is a text change.

const NBSP = /[\u00a0\u2007\u202f]/g;
const WS = /[ \t\r\n\f\v]+/g;
// Zero width space, byte order mark and soft hyphen: invisible artefacts of editing and export. Up to 0.2.12 the
// zero width joiner and non-joiner went with them, and two texts that render differently, such as an emoji
// sequence with and without its joiner, compared equal (found by an outside review 2026-09-26). They stay in the
// strict text now, and JOINERS takes them out of the loose text, so a difference in them alone is a minor change.
const ZERO_WIDTH = /[\u200b\ufeff\u00ad]/g;
const JOINERS = /[\u200c\u200d]/g;

export function strictNormalize(text: string): string {
  return text
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .replace(NBSP, ' ')
    .replace(WS, ' ')
    .trim();
}

/** The folding the loose text and the text key share: joiners out, case folded, typographic quotes, dashes and the
 * ellipsis in their plain forms. */
function fold(text: string): string {
  return strictNormalize(text)
    .replace(JOINERS, '')
    .toLowerCase()
    // Map typographic quotes and dashes to plain forms, for alignment and for classifying minor text differences.
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...');
}

/** The key that aligns blocks: everything that is not a letter, a number or white space becomes a space, so two
 * blocks that differ in punctuation, marks or symbols still pair. */
export function looseNormalize(text: string): string {
  return fold(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Code points that render as nothing by default: variation selectors, the combining grapheme joiner, the word joiner
// and the like. They are not content, so a difference in them alone is not a text change.
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/** The key that classifies a text difference: the loose text, except that the marks (\p{M}) and the symbols (\p{S})
 * are kept, because a different vowel sign, check mark, arrow, comparison or plus sign shows the reader something
 * else. Only case, punctuation, typographic quotes and dashes, joiners and invisible code points stay minor
 * (MP-11). Two texts with the same key but different strict text are TEXT_MINOR_CHANGED; with different keys they
 * are TEXT_CHANGED. The key is not used for alignment. */
export function textKey(text: string): string {
  return fold(text)
    .replace(IGNORABLE, '')
    .replace(/[^\p{L}\p{N}\p{M}\p{S}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Code with every run of whitespace collapsed to one space, nothing else touched. Whitespace is the ASCII
 * whitespace characters and the Unicode space separators (\p{Zs}, which includes the no-break space). There is no
 * Unicode normalization and no removal of zero width characters. Two code blocks that are equal here differ only in whitespace or indentation;
 * a changed soft hyphen or a composed against a decomposed letter is a change of the code (0.2.22, found by an
 * outside review 2026-10-02). */
export function codeWhitespaceKey(code: string): string {
  return code.replace(/[\p{Zs}\t\r\n\f\v]+/gu, ' ').replace(/^ | $/g, '');
}

/** Code content: CRLF and CR line endings become LF and every trailing newline is removed; other whitespace is kept.
 * The trailing newlines are counted off from the end. The expression /\n+$/ that did this up to 0.2.38 starts a new
 * scan at every newline of a long run and takes time quadratic in its length. */
export function normalizeCode(code: string): string {
  const text = code.replace(/\r\n?/g, '\n');
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x0a) end--;
  return end === text.length ? text : text.slice(0, end);
}

// Terminal control characters (ANSI escape sequences, C0 and C1 controls), the Unicode bidi controls, the line and
// paragraph separators and the tag characters reach a text report unescaped if a
// compared page or an argument carries one. --format json is safe only in part on its own: JSON.stringify escapes
// the C0 controls (U+0000 to U+001F) and lone surrogates, and leaves U+007F, the C1 controls and the bidi controls
// literal. It is safe in practice because renderJson sends every string value through redactText first, so this
// strip covers the JSON output as well. Tab, newline and carriage return are kept: they are ordinary formatting, and by the
// time most report text reaches this point strictNormalize has already collapsed them to a single space anyway.
// C1 controls (U+0080 to U+009F) include the single-byte CSI (U+009B), which some terminals read as an escape. The bidi
// controls (U+202A to U+202E and U+2066 to U+2069) reorder the text a reader sees, so a quoted excerpt could read
// differently in a report than in the page. Both ranges match the hosted validator's stripControls(stripBidi()).
// Since 0.2.39 the left-to-right and right-to-left marks and the Arabic letter mark (U+200E, U+200F, U+061C) go too,
// as the comment above said the bidi controls did, and so do U+2028 and U+2029, which some viewers read as a line
// break, and the tag characters (U+E0000 to U+E007F), which no reader sees and a program reading the report can. The
// zero width joiner and non-joiner and the variation selectors stay: emoji and several scripts need them.
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202A-\u202E\u2066-\u2069\u{e0000}-\u{e007f}]/gu;

/** Removes the escape character (which starts an ANSI escape sequence), the other C0 and C1 controls and the Unicode
 * bidi controls from a value that may come from a compared page or a raw argument, so a plain --format text report
 * cannot replay them at the terminal (0.2.16, found by an outside review 2026-09-28). The printable rest of an escape
 * sequence, such as the "[2J" of ESC [ 2 J, stays as inert text. */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

// A numeric token: optional sign (ASCII hyphen, Unicode minus or plus) that is not preceded by a letter
// or digit (so the "-09" in 2026-09-10 is a separator, not a sign), digits of any script (\p{Nd}, so Arabic-Indic
// and fullwidth digits carry a sign too, MP-12) with inner separators (decimal, thousands, date, time, version),
// optional percent or currency sign on either side.
const NUMBER_RE = /(?<![\p{L}\p{N}])(?:[€$£]\s?)?[-\u2212+]?\p{Nd}+(?:[.,:\/\-\u2010-\u2015\u2212]\p{Nd}+)*\s?(?:%|€|\$|£)?/gu;

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
  const t = redactText(strictNormalize(dropAuthorityControls(text)));
  return t.length <= max ? t : t.slice(0, max - 1) + '\u2026';
}

// URL-like runs inside free text: absolute URLs, www. hosts, and root-relative paths that carry a query
// or fragment. Only the query values and the fragment are rewritten; other text is left untouched.
//
// Up to 0.2.1 this was one regular expression, kept in test/linear.test.ts as the reference. Its time was
// quadratic in the length of a run without whitespace (CodeQL js/polynomial-redos; 80 000 characters took
// seconds), and the text comes from the compared page. Every alternative of that expression ends where the
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
  // (?<![\w.-])(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[\w-]+\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+))(?::\d+)?(?:[\/\\]|#(?=...=))
  // A bare host name followed by a path (0.2.39): dotted labels that end in a letters-only label of two or more
  // characters or in an xn-- label, a dotted IPv4 address or localhost, then an optional port, then a slash or a
  // backslash, or a fragment with an equals sign somewhere after it. The host is not glued to a word, dot or hyphen
  // before it. A query value or fragment of such an address, example.com/cb#access_token=..., reached a report
  // unmasked; rewriteBareHost hides a query or a fragment of such an address only when it holds an equals sign. A
  // file name, a version number and an abbreviation have no such ending, and a fragment without an equals
  // sign after a host that has no slash, as in README.md#section, is prose.
  const host = bareHostStart(t, s, e);
  if (host >= 0 && (best < 0 || host < best)) best = host;
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
  // [\/\\]{2}[^\s<>"'()\/\\?#]*@  An authority that carries user information (0.2.10): the first pair of
  // slashes or backslashes whose authority, up to the next / \ ? or #, holds an '@'. Without it
  // //user:secret@host/path passed through a report unmasked, because no other alternative reads a run without
  // a scheme, query or fragment, and neither did https:\\user:secret@host, because the scheme alternative wants
  // "://". A failed candidate is scanned only to its own delimiter, so the scans do not overlap.
  const isSep = (c: number) => c === 0x2f || c === 0x5c;
  for (let p = s; p + 2 < e && (best < 0 || p < best); p++) {
    if (!isSep(t.charCodeAt(p)) || !isSep(t.charCodeAt(p + 1))) continue;
    let k = p + 2;
    while (k < e) {
      const c = t.charCodeAt(k);
      if (c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23 || c === 0x40) break;
      k++;
    }
    if (k < e && t.charCodeAt(k) === 0x40) {
      best = p;
      break;
    }
    if (k > p + 2) p = k - 1;
  }
  // (?:https?|ftp|wss?|file):[\/\\]*[^\s<>"'()\/\\?#@]*@  A special scheme whose authority carries user information,
  // behind any number of slashes or backslashes, none included (0.2.12). The URL parser reads an authority after a
  // special scheme whatever the separators, so https:user:secret@host and https:\user:secret@host carry user
  // information just as https://user:secret@host does, and both passed a report unmasked, the first also as a GFM
  // email link (found by an independent review before 0.2.12 was released). A failed candidate found no '@' before
  // its delimiter, so a later candidate can succeed only when its colon sits right before that delimiter and the
  // delimiter is its separator: the search goes on from at most the length of "https:" before the delimiter, and
  // each position is scanned a bounded number of times.
  for (let p = s; p < e && (best < 0 || p < best); p++) {
    const n = specialSchemeLength(t, p, e);
    if (n < 0) continue;
    let k = p + n + 1;
    while (k < e && isSep(t.charCodeAt(k))) k++;
    while (k < e) {
      const c = t.charCodeAt(k);
      if (c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23 || c === 0x40) break;
      k++;
    }
    if (k < e && t.charCodeAt(k) === 0x40) {
      best = p;
      break;
    }
    p = Math.max(p, k - 7);
  }
  return best;
}

/** Start of the first bare host name with a path in the run t[s, e), or -1. A chain of labels is read once from its
 * first character, so the scan is linear: the position of the last equals sign of the run is found once, so a fragment
 * is not rescanned for each chain before it. */
function bareHostStart(t: string, s: number, e: number): number {
  const isLabelChar = (c: number) => isLetter(c) || isDigit(c) || c === 0x2d || c === 0x5f;
  let lastEquals = e - 1;
  while (lastEquals >= s && t.charCodeAt(lastEquals) !== 0x3d) lastEquals--;
  let i = s;
  while (i < e) {
    const before = i > 0 ? t.charCodeAt(i - 1) : -1;
    const c = t.charCodeAt(i);
    if (!isLabelChar(c) || (i > s && (isWord(before) || before === 0x2e || before === 0x2d))) {
      i++;
      continue;
    }
    // One chain of labels starting at i.
    let j = i;
    let labels = 0;
    let lastStart = i;
    for (;;) {
      lastStart = j;
      while (j < e && isLabelChar(t.charCodeAt(j))) j++;
      labels++;
      if (j + 1 < e && t.charCodeAt(j) === 0x2e && isLabelChar(t.charCodeAt(j + 1))) j++;
      else break;
    }
    let tld = j - lastStart >= 2;
    for (let k = lastStart; tld && k < j; k++) if (!isLetter(t.charCodeAt(k))) tld = false;
    if (!tld && j - lastStart >= 5) {
      // A punycode label, xn-- and then letters, digits and hyphens.
      const fold = (c: number) => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
      tld = fold(t.charCodeAt(lastStart)) === 0x78 && fold(t.charCodeAt(lastStart + 1)) === 0x6e && t.charCodeAt(lastStart + 2) === 0x2d && t.charCodeAt(lastStart + 3) === 0x2d;
      for (let k = lastStart + 4; tld && k < j; k++) if (t.charCodeAt(k) === 0x5f) tld = false;
    }
    let host = labels >= 2 && tld;
    if (!host && labels === 4) {
      // A dotted IPv4 address: four labels of one to three digits.
      host = true;
      for (let k = i, len = 0; host && k <= j; k++) {
        if (k === j || t.charCodeAt(k) === 0x2e) {
          if (len < 1 || len > 3) host = false;
          len = 0;
        } else if (isDigit(t.charCodeAt(k))) len++;
        else host = false;
      }
    }
    if (!host && labels === 1 && j - i === 9) {
      // localhost, in any case.
      host = true;
      for (let k = 0; host && k < 9; k++) {
        const c = t.charCodeAt(i + k);
        const f = c === 0x17f ? 0x73 : c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
        host = f === 'localhost'.charCodeAt(k);
      }
    }
    let k = j;
    if (k < e && t.charCodeAt(k) === 0x3a) {
      k++;
      const digits = k;
      while (k < e && isDigit(t.charCodeAt(k))) k++;
      if (k === digits) k = j;
    }
    if (host && k < e) {
      const c = t.charCodeAt(k);
      if (c === 0x2f || c === 0x5c || (c === 0x23 && lastEquals > k)) return i;
    }
    i = j > i ? j : i + 1;
  }
  return -1;
}

const SPECIAL_SCHEME_NAMES = ['https', 'http', 'ftp', 'wss', 'ws', 'file'];

/** Length of the special scheme name at t[p] when a colon follows it, else -1. Letters compare with the old
 * expression's i and u flags, under which U+017F matches s. */
function specialSchemeLength(t: string, p: number, e: number): number {
  const fold = (c: number) => (c === 0x17f ? 0x73 : c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
  for (const name of SPECIAL_SCHEME_NAMES) {
    if (p + name.length >= e || t.charCodeAt(p + name.length) !== 0x3a) continue;
    let ok = true;
    for (let i = 0; i < name.length && ok; i++) ok = fold(t.charCodeAt(p + i)) === name.charCodeAt(i);
    if (ok) return name.length;
  }
  return -1;
}

// The rest of the token after a URL-like run. A run ends at ( ) " and ', but a URL can carry all four, so once a
// URL has started it goes on to the next whitespace, < or >. Up to 0.2.11 the URL ended at the run, and a query
// value such as ?token=(4711) left the parenthesis and the digits outside the mask, where the report showed them
// as text and as a changed number (found by an outside review 2026-09-26). Text glued to a query value without a
// space, such as the 's of ?x=1's, is part of the value to the URL parser too, and is masked with it.
const TOKEN_TAIL = /[^\s<>]*/uy;

/** End of the URL that starts at p inside the token t[p, t): trailing sentence punctuation, quotes and closing
 * parentheses that have no opening one inside the URL are left outside it. One pass, so the scan stays linear. */
function urlEnd(text: string, p: number, t: number): number {
  let open = 0;
  let close = 0;
  for (let k = p; k < t; k++) {
    const c = text.charCodeAt(k);
    if (c === 0x28) open++;
    else if (c === 0x29) close++;
  }
  let end = t;
  while (end > p) {
    const c = text[end - 1]!;
    if (TRAIL.includes(c) || c === '"' || c === "'") end--;
    else if (c === ')' && close > open) {
      close--;
      end--;
    } else break;
  }
  return end;
}

/** End of the token whose run ends at e: the run end moved forward over TOKEN_TAIL. */
function tokenEnd(text: string, e: number): number {
  TOKEN_TAIL.lastIndex = e;
  const m = TOKEN_TAIL.exec(text);
  return e + (m ? m[0].length : 0);
}

/** Whether the URL-like match at p in the run t[s, e) is a bare host with a path: a match that starts at a host name
 * and not at a scheme, "www.", slashes or a path. */
function isBareHostMatch(t: string, s: number, e: number, p: number): boolean {
  if (bareHostStart(t, s, e) !== p) return false;
  const w = (c: number) => (c === 0x57 || c === 0x77 ? 1 : 0);
  return !(p + 3 < e && w(t.charCodeAt(p)) && w(t.charCodeAt(p + 1)) && w(t.charCodeAt(p + 2)) && t.charCodeAt(p + 3) === 0x2e);
}

/** The rewrite of a bare host with a path, such as example.com/docs/guide#step-3 (0.2.39). Its query and its fragment
 * are hidden only when they carry a value, an equals sign, as in example.com/cb#access_token=... and
 * example.com/cb?t=...: an anchor, a line number and a query without a value are shown as they are, because a page
 * that differs in one of them must show the difference. The path is never hidden. */
function rewriteBareHost(url: string, rewrite: (url: string) => string): string {
  const hashAt = url.indexOf('#');
  const fragment = hashAt < 0 ? '' : url.slice(hashAt);
  const head = hashAt < 0 ? url : url.slice(0, hashAt);
  const q = head.indexOf('?');
  const queryHasValue = q >= 0 && head.indexOf('=', q) >= 0;
  const hideFragment = fragment.includes('=');
  if (!queryHasValue && !hideFragment) return url;
  return (queryHasValue ? rewrite(head) : head) + (hideFragment ? '' : fragment);
}

/** Rewrites the URL-like part of every run in a piece of text and leaves the rest untouched. */
function rewriteUrlRuns(text: string, rewrite: (url: string) => string): string {
  let out = '';
  let done = 0;
  const runs = new RegExp(RUN.source, RUN.flags);
  for (let run = runs.exec(text); run !== null; run = runs.exec(text)) {
    const s = run.index;
    const e = s + run[0].length;
    const p = urlStart(text, s, e);
    if (p < 0) continue;
    const t = tokenEnd(text, e);
    const end = urlEnd(text, p, t);
    const url = text.slice(p, end);
    out += text.slice(done, p) + (isBareHostMatch(text, s, e, p) ? rewriteBareHost(url, rewrite) : rewrite(url)) + text.slice(end, t);
    done = t;
    runs.lastIndex = t;
  }
  return out + text.slice(done);
}

// How far insideHiddenUrlPart reads the token around a position. A longer token counts as hidden.
const HIDDEN_SCAN = 4096;

// A userinfo wrapped in parentheses right after "scheme://", such as scheme://(name):secret@host, is not a
// URL-like run under RUN above, because "(" and ")" split runs there: "scheme://", the parenthesized name and
// the rest starting at the colon become three separate runs, and none of them alone looks like a URL with user
// information (found by an outside review 2026-09-28).
//
// Fail-closed (found by an outside review 2026-09-28): up to here the whole shape (scheme, name, secret and the
// closing "@") was one regex whose name and secret each carried a fixed quantifier cap (256 and 1024 characters).
// A name or secret one character longer than its own cap made the regex fail to match at that position at all, so
// the userinfo reached a report completely unmasked instead of masked, the opposite of what a redaction function
// should do when it cannot tell how long something is. nextParenUserinfo below finds the fixed "scheme://(" start
// with a small bounded regex (the scheme name itself is capped at 32 characters, which no real scheme name
// approaches) and then reads the name and the secret by hand with indexOf, inside PAREN_USERINFO_SCAN characters
// of that point: a name or secret near the old 256/1024 limits, or well past them, is found and masked all the
// same, as long as its closing ")" or its "@" sits within that window. When the secret's end cannot be found that
// way either (no "@" and no other stopping character before the window runs out), the match is still made and
// masked through the end of the window, because not knowing where a credential ends is a reason to mask more of
// it, not less. This keeps the scan linear in the length of the text: each "(" is looked at once, and the work
// done for it is bounded by PAREN_USERINFO_SCAN regardless of how long the rest of the text is, the same trade-off
// HIDDEN_SCAN below already makes for the same class of problem.
const PAREN_USERINFO_START = /\b([a-z][a-z0-9+.-]{0,31}):\/\/\(/giu;
const PAREN_USERINFO_SCAN = HIDDEN_SCAN;
// How far past a position a match that STARTS before that position can read. The scheme is at most 32 characters
// and "://(" is 4, so nameStart is at most 35 past that position. The ")" must be followed by ":" inside
// the name window, so secretStart is at most nameStart + PAREN_USERINFO_SCAN, and the secret window ends at most
// PAREN_USERINFO_SCAN after that. 36 + 2 * PAREN_USERINFO_SCAN covers all three with one character to spare.
const PAREN_USERINFO_MATCH_SPAN = 36 + 2 * PAREN_USERINFO_SCAN;

interface ParenUserinfoMatch {
  /** Start of the whole match, at the first character of the scheme name. */
  start: number;
  scheme: string;
  /** Start of the parenthesized name, right after "(". */
  nameStart: number;
  /** Start of the secret, right after "):". */
  secretStart: number;
  /** End of the secret: the "@" when one was found, otherwise the bound where the search gave up. */
  secretEnd: number;
  /** One past the match: an "@" that ends it, or secretEnd itself when there was no "@" to include. */
  end: number;
}

/** Finds the next "scheme://(name):secret@" match at or after `from`. See the fail-closed rationale above. */
function nextParenUserinfo(text: string, from: number): ParenUserinfoMatch | null {
  const re = new RegExp(PAREN_USERINFO_START.source, PAREN_USERINFO_START.flags);
  re.lastIndex = from;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const nameStart = m.index + m[0].length;
    const nameWindowEnd = Math.min(text.length, nameStart + PAREN_USERINFO_SCAN);
    const nameWindow = text.slice(nameStart, nameWindowEnd);
    const close = nameWindow.indexOf(')');
    const stop = nameWindow.search(/[\s(]/);
    if (close < 0 && stop < 0 && nameWindowEnd - nameStart === PAREN_USERINFO_SCAN) {
      // The name is longer than the window and has no ")" and no stopping character in it, so its end cannot be
      // found. A secret may follow it, so this is masked fail-closed too: from the "(" through the next "@", or
      // through the end of the token (the next whitespace, angle bracket or quote, else the end of the text) when
      // there is no "@". The match is consumed, so the scan stays linear (0.2.37).
      const stopRe = /[@\s<>"']/g;
      stopRe.lastIndex = nameWindowEnd;
      const tailMatch = stopRe.exec(text);
      const atTail = tailMatch !== null && tailMatch[0] === '@';
      const secretEnd = tailMatch === null ? text.length : tailMatch.index;
      return { start: m.index, scheme: m[1]!, nameStart, secretStart: nameWindowEnd, secretEnd, end: atTail ? secretEnd + 1 : secretEnd };
    }
    if (close < 0 || (stop >= 0 && stop < close) || text[nameStart + close + 1] !== ':') {
      // No well-formed "):" landmark within the window: this "(" is not the shape we mask, so it is left as it is
      // and the search resumes right after it, not from the start again.
      re.lastIndex = nameStart;
      continue;
    }
    const secretStart = nameStart + close + 2;
    const secretWindowEnd = Math.min(text.length, secretStart + PAREN_USERINFO_SCAN);
    const secretWindow = text.slice(secretStart, secretWindowEnd);
    // Once the "):" landmark is found, this is the dangerous shape, so the secret is always masked from here on,
    // through an "@", another character that could not be part of it, or the scan bound itself (fail-closed).
    const stopChar = secretWindow.search(/[@\s()<>"']/);
    const atStop = stopChar >= 0 && secretWindow[stopChar] === '@';
    const secretEnd = stopChar < 0 ? secretWindowEnd : secretStart + stopChar;
    return { start: m.index, scheme: m[1]!, nameStart, secretStart, secretEnd, end: atStop ? secretEnd + 1 : secretEnd };
  }
  return null;
}

/** Masks every "scheme://(name):secret@" userinfo, leaving the scheme and an unmasked "***@" behind so the rest
 * of the URL (host, path, query, fragment) reaches the ordinary run-based masking below as one unbroken run. */
export function maskParenUserinfo(text: string): string {
  let out = '';
  let pos = 0;
  for (let m = nextParenUserinfo(text, pos); m !== null; m = nextParenUserinfo(text, pos)) {
    out += text.slice(pos, m.start) + `${m.scheme}://***@`;
    pos = m.end;
  }
  return out + text.slice(pos);
}

/** Whether position `at` falls inside the parenthesized name or the secret of a nextParenUserinfo match, the same
 * span maskParenUserinfo hides. Only a match that starts inside the same HIDDEN_SCAN window insideHiddenUrlPart
 * itself uses can count. The regular expression search runs on a prefix of the text that ends
 * PAREN_USERINFO_MATCH_SPAN characters after that window. The prefix keeps every index and is not cut on the
 * left, so the word boundary at the start of a match sees the same character as on the whole text, and every match
 * that starts inside the window sees the same name and secret windows. Up to 0.2.30 the search ran on the whole
 * text and went on to its end when nothing matched, so a file with many bare autolinks took quadratic time. */
export function insideParenUserinfo(text: string, at: number): boolean {
  const from = Math.max(0, at - HIDDEN_SCAN);
  const to = Math.min(text.length, at + HIDDEN_SCAN);
  const haystack = text.slice(0, Math.min(text.length, to + PAREN_USERINFO_MATCH_SPAN));
  let pos = from;
  while (pos < to) {
    const m = nextParenUserinfo(haystack, pos);
    if (!m || m.start >= to) return false;
    const hiddenStart = m.nameStart - 1; // the "("
    if (at >= hiddenStart && at < m.secretEnd) return true;
    pos = m.end;
  }
  return false;
}
/**
 * Whether position at of a source text lies in a part of a URL that maskHref hides: user information, a query
 * value or the fragment. GFM links a bare address it finds inside another URL on its own: the part after the
 * colon of https://user_name:secret@host, which it reads as an email address, or a URL given as a query value.
 * That link's text and target then reached the report unmasked, because on their own they no longer look like
 * part of a URL (found by an outside review 2026-09-26). The URL is found the way rewriteUrlRuns finds it, in the
 * token around the position; a token longer than HIDDEN_SCAN on either side counts as hidden, so the answer errs
 * on the side of masking.
 */
export function insideHiddenUrlPart(text: string, at: number): boolean {
  if (insideParenUserinfo(text, at)) return true;
  const isEdge = (i: number) => {
    const ch = text[i]!;
    return ch === '<' || ch === '>' || /\s/u.test(ch);
  };
  let start = at;
  while (start > 0 && !isEdge(start - 1)) {
    if (at - start >= HIDDEN_SCAN) return true;
    start--;
  }
  let stop = at;
  while (stop < text.length && !isEdge(stop)) {
    if (stop - at >= HIDDEN_SCAN) return true;
    stop++;
  }
  const token = text.slice(start, stop);
  const offset = at - start;
  const runs = new RegExp(RUN.source, RUN.flags);
  for (let run = runs.exec(token); run !== null && run.index < offset; run = runs.exec(token)) {
    const p = urlStart(token, run.index, run.index + run[0].length);
    if (p < 0) continue;
    if (p >= offset) return false;
    const before = token.slice(p, offset);
    if (/[?#]/.test(before)) return true;
    // Still inside the authority: what came before the position is user information. A special scheme has an
    // authority behind any number of separators, none included.
    return /^(?:(?:https?|ftp|wss?|file):[\/\\]*|(?:[a-z][a-z0-9+.-]*:)?[\/\\]{2})[^\/\\?#]*$/i.test(before);
  }
  return false;
}

const isSpaceCode = (c: number) => (c < 0x80 ? c === 0x20 || (c >= 0x09 && c <= 0x0d) : /\s/u.test(String.fromCharCode(c)));

/**
 * Masks the user information of every "scheme://authority" in a piece of text, wherever the scheme sits and
 * whatever the user information starts with (0.2.39, found by an outside review 2026-11-14). The run-based masking
 * above reads the text in runs that end at white space and at the characters < > " ' ( ), so a URL whose user name
 * opens with one of them, such as https://"admin":secret@host/ or https://(token)@host/, was cut in two runs, and a
 * URL that follows "=", "," or ":" in the same run, such as redirect_uri=https://u:secret@host/cb?state=1, was read as
 * one run that starts at its first character, where the parser finds no scheme and so no user information. Here the
 * authority is the text after "://" up to the next slash, backslash, question mark, number sign or white space, as
 * the URL parser reads it, and its user information ends at the last "@" in it. The scheme is the run of scheme
 * characters before "://" that holds a letter. The user information becomes ***, so the host, path and query reach
 * the run-based masking as before. One pass: an authority ends at a slash, so no two of them overlap.
 *
 * With whiteSpaceInside, a tab, a line feed or a carriage return inside the authority does not end it, as the URL
 * parser removes them, and nor does any other white space when the text up to the last "@" holds a colon that is not
 * followed by white space ("https://example.com: see me@x.org" is prose), so
 * https://us er:secret@host/ and https://user:pa ss@host/ are masked whole. Without a colon the white space ends the
 * authority, so "visit https://example.com for me@x.org" is prose. The authority does not go on past white
 * space either when the text between its last colon and that white space is a port, one to five digits, or the end
 * of a bracketed host, so "Use https://api.example.com:8443 or write to ops@example.org" keeps the address; a
 * password of digits only that is followed by white space is therefore not masked. The report text uses it, and from
 * 0.2.43 so do the numbers a number finding shows (hideUrlSecrets).
 */
export function maskAuthorityUserinfo(text: string, whiteSpaceInside = false): string {
  const spans = findUserinfoSpans(text, whiteSpaceInside);
  if (spans.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.from) + '***@';
    pos = s.at + 1;
  }
  return out + text.slice(pos);
}

/** One user information found by findUserinfoSpans: start is the first character of the scheme, from the first
 * character after "://" and at the "@" that ends the user information. */
export interface UserinfoSpan {
  start: number;
  from: number;
  at: number;
}

/** One to five ASCII digits in text[from, to): a port. */
function isPortText(text: string, from: number, to: number): boolean {
  if (to - from < 1 || to - from > 5) return false;
  for (let k = from; k < to; k++) if (!isDigit(text.charCodeAt(k))) return false;
  return true;
}

/** The user information of every "scheme://authority" of a text, in order and without overlap. The rules are the
 * ones maskAuthorityUserinfo describes. */
export function findUserinfoSpans(text: string, whiteSpaceInside = false): UserinfoSpan[] {
  const spans: UserinfoSpan[] = [];
  let pos = 0;
  let from = 0;
  // The next "://", searched again only when the text up to it is behind: -2 is not searched yet, -1 is none left.
  let colonAt = -2;
  for (;;) {
    if (colonAt === -2 || (colonAt >= 0 && colonAt < from)) colonAt = text.indexOf('://', from);
    // With whiteSpaceInside, the authority of a network-path reference, "//name:secret@host/p" with no scheme, counts
    // too (0.2.43): a report shows the same text a link target would, and movedUserinfoMask reads that target.
    const bare = whiteSpaceInside ? indexOfBareSlashes(text, from, colonAt < 0 ? text.length : colonAt) : -1;
    let start: number;
    let authFrom: number;
    let hasLetter = false;
    if (bare >= 0) {
      start = bare;
      authFrom = bare + 2;
      hasLetter = true;
    } else {
      if (colonAt < 0) break;
      authFrom = colonAt + 3;
      start = colonAt;
      for (let k = colonAt; k > pos && isSchemeChar(text.charCodeAt(k - 1)); k--) {
        start = k - 1;
        if (isLetter(text.charCodeAt(k - 1))) hasLetter = true;
      }
    }
    from = authFrom;
    if (!hasLetter) continue;
    let at = -1;
    let lastAt = -1;
    let firstSpace = -1;
    let firstColon = -1;
    let lastColon = -1;
    let seenSpace = false;
    for (let e = from; e < text.length; e++) {
      const c = text.charCodeAt(e);
      if (c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23) break;
      if (whiteSpaceInside && !seenSpace && isSpaceCode(c)) {
        seenSpace = true;
        // A port or the end of a bracketed host before the first white space: what follows is text, not user information.
        if ((lastColon >= 0 && isPortText(text, lastColon + 1, e)) || text.charCodeAt(e - 1) === 0x5d) break;
      }
      if (isSpaceCode(c) && !(whiteSpaceInside && (c === 0x09 || c === 0x0a || c === 0x0d))) {
        if (!whiteSpaceInside) break;
        if (firstSpace < 0) firstSpace = e;
        continue;
      }
      if (c === 0x3a) {
        lastColon = e;
        // A tab after the colon is removed by the URL parser, so it does not make the colon a label of prose as a plain
        // space does (0.2.43, QA-2 D5). A line break stays prose here: "host:" at the end of a line is a label.
        const next = text.charCodeAt(e + 1);
        if (firstColon < 0 && (!isSpaceCode(next) || next === 0x09)) firstColon = e;
      }
      if (c === 0x40) {
        lastAt = e;
        if (firstSpace < 0) at = e;
      }
    }
    if (lastAt > firstSpace && firstSpace >= 0 && firstColon >= 0 && firstColon < lastAt) at = lastAt;
    if (at < 0) continue;
    // A network-path reference without a scheme counts only with a colon in front of its "@", a password, as in
    // //name:secret@host/p; "//name@host/p" holds no secret the report text needs to hide.
    if (bare >= 0 && !(firstColon >= 0 && firstColon < at)) continue;
    spans.push({ start, from: authFrom, at });
    pos = at + 1;
    from = pos;
  }
  return spans;
}

/** The first "//" in text[from, limit) that starts a network-path reference: the start of the text, or a character
 * that is not a scheme character, a colon, a slash or a backslash in front of it. "a.example//b", "x://y" and "/a//b"
 * hold none. */
function indexOfBareSlashes(text: string, from: number, limit: number): number {
  let i = from;
  while (i < limit) {
    i = text.indexOf('//', i);
    if (i < 0 || i >= limit) return -1;
    const prev = i === 0 ? -1 : text.charCodeAt(i - 1);
    if (prev === -1 || !(isSchemeChar(prev) || prev === 0x3a || prev === 0x2f || prev === 0x5c)) return i;
    i++;
  }
  return -1;
}

/** The text as a report shows it, for a raw text whose white space the credential masking needs: undefined when
 * dropAuthorityControls changes nothing, else the normalized text without the white space inside user information.
 * It is for display only. The comparison keys come from strictNormalize alone, as in 0.2.38, because removing the
 * white space there made two texts that differ only in the kind of white space compare unequal, and the reverse. */
export function shownNormalize(raw: string): string | undefined {
  const dropped = dropAuthorityControls(raw);
  return dropped === raw ? undefined : strictNormalize(dropped);
}

/** shownNormalize as an object to spread into a block or a link: {} or { shown }. */
export function shownField(raw: string): { shown?: string } {
  const s = shownNormalize(raw);
  return s === undefined ? {} : { shown: s };
}

const CONTROL_WHITE_SPACE = /[\t\n\v\f\r]/;

/**
 * Removes a tab, a vertical tab, a form feed, a line feed or a carriage return from the user information of a
 * "scheme://authority" when it is a credential, in a text that is only displayed, before the white space is
 * collapsed into a plain space. It is never part of a comparison key. The URL
 * parser drops a tab, a line feed and a carriage return from an address, and none of the five can stand in a user
 * name or a password a reader sees, but a plain space after the colon of "https://user: secret@host" makes the
 * masking read prose, so the password reached the report. Only an authority that ends at the first white space other
 * than these five is read, and only one that holds a colon in front of the last "@", which is not followed by a plain
 * space and does not end a port: "https://example.com:8443" and a line break and then an address is text. Without
 * a colon only a tab, a vertical tab and a form feed count, because a line break between an address and an e-mail
 * address is ordinary text.
 */
export function dropAuthorityControls(text: string): string {
  if (!CONTROL_WHITE_SPACE.test(text) || !text.includes('//')) return text;
  let out = '';
  let pos = 0;
  let from = 0;
  for (;;) {
    const colon = text.indexOf('://', from);
    // A network-path reference, "//name:secret@host/p", is read too (0.2.43, QA-2 D5): the tab after its colon is part of
    // the user information, and the page text has turned it into a space by the time the masking reads it.
    const bare = indexOfBareSlashes(text, from, colon < 0 ? text.length : colon);
    if (colon < 0 && bare < 0) break;
    let hasLetter = false;
    if (bare >= 0) {
      from = bare + 2;
      hasLetter = true;
    } else {
      from = colon + 3;
      for (let k = colon; k > pos && isSchemeChar(text.charCodeAt(k - 1)); k--) {
        if (isLetter(text.charCodeAt(k - 1))) hasLetter = true;
      }
    }
    if (!hasLetter) continue;
    let lastAt = -1;
    for (let e = from; e < text.length; e++) {
      const c = text.charCodeAt(e);
      if (c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23) break;
      if (isSpaceCode(c) && !isControlWhiteSpace(c)) break;
      if (c === 0x40) lastAt = e;
    }
    if (lastAt < 0) continue;
    let firstControl = -1;
    let lastColon = -1;
    let lineBreak = false;
    let colonRule = false;
    for (let e = from; e < lastAt; e++) {
      const c = text.charCodeAt(e);
      if (isControlWhiteSpace(c)) {
        if (firstControl < 0) firstControl = e;
        if (c === 0x0a || c === 0x0d) lineBreak = true;
      } else if (c === 0x3a) {
        if (firstControl < 0) lastColon = e;
        const next = text.charCodeAt(e + 1);
        if (!isSpaceCode(next) || isControlWhiteSpace(next)) colonRule = true;
      }
    }
    if (firstControl < 0) continue;
    // Without a scheme the reference counts only with a colon in front of the "@": "//name@host" holds no secret.
    if (bare >= 0 && !colonRule) continue;
    if (lastColon >= 0 && isPortText(text, lastColon + 1, firstControl)) continue;
    if (firstControl > from && text.charCodeAt(firstControl - 1) === 0x5d) continue;
    if (!colonRule && lineBreak) continue;
    out += text.slice(pos, from) + text.slice(from, lastAt).replace(/[\t\n\v\f\r]/g, '');
    pos = lastAt;
    from = lastAt + 1;
  }
  return pos === 0 ? text : out + text.slice(pos);
}

const isControlWhiteSpace = (c: number) => c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d;

/** The user information of a source text, computed once for the positions of its links. The characters that
 * stripControlChars removes are read as a tab, which keeps every position and does not end an authority. */
export function userinfoSpansOf(text: string): UserinfoSpan[] {
  return findUserinfoSpans(text.replace(CONTROL_CHARS, (m) => '\t'.repeat(m.length)), true);
}

/** Whether position at lies in a user information of spans, scheme included, the "@" included. */
export function insideUserinfoSpan(spans: UserinfoSpan[], at: number): boolean {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid]!;
    if (at < s.start) hi = mid - 1;
    else if (at > s.at) lo = mid + 1;
    else return true;
  }
  return false;
}

// Schemes whose address part is an e-mail address or a user at a host by design. "mailto:jane@example.com/x" and the
// like are shown as written, so the masking of a name and a secret before an "@" does not reach them.
const ADDRESS_SCHEMES = new Set(['mailto', 'xmpp', 'sip', 'sips', 'acct', 'im']);

/** Whether t[from, to) is a host name followed by an optional port, by the rule bareHostStart uses: dotted labels that
 * end in a letters-only label of two or more characters or in an xn-- label, a dotted IPv4 address or localhost. A
 * trailing dot, an empty label and a name with no dot other than localhost are not hosts. */
function isBareHostText(t: string, from: number, to: number): boolean {
  let end = to;
  let k = to;
  while (k > from && isDigit(t.charCodeAt(k - 1))) k--;
  if (k < to && k > from + 1 && t.charCodeAt(k - 1) === 0x3a) end = k - 1;
  if (end <= from) return false;
  let labels = 1;
  let lastStart = from;
  for (let i = from; i < end; i++) {
    const c = t.charCodeAt(i);
    if (c === 0x2e) {
      if (i === lastStart || i + 1 >= end) return false;
      labels++;
      lastStart = i + 1;
    } else if (!(isLetter(c) || isDigit(c) || c === 0x2d || c === 0x5f)) return false;
  }
  const name = t.slice(from, end);
  if (labels === 1) return name.replace(/\u017f/g, 's').toLowerCase() === 'localhost';
  const last = t.slice(lastStart, end);
  if (last.length >= 2 && /^[A-Za-z\u017f\u212a]+$/u.test(last)) return true;
  if (last.length >= 5 && /^xn--[^_]*$/i.test(last)) return true;
  return labels === 4 && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name);
}

/**
 * The credential-shaped "label:name@host" of a text that has no scheme separator, as in user:secret@host.example/p
 * (0.2.40, found by an independent check of 0.2.39). The URL parser reads "user:" as a scheme and the rest as an opaque
 * path, so maskHref found no user information, and GFM read "secret@host.example" as an e-mail address, so the
 * secret reached a report as an excerpt and as the text and the target of a link. A span is found in a run (RUN) when
 * a label, the letters, digits and the characters + . - that start with a letter and follow no scheme character,
 * is followed by a colon and then by text that holds an "@" before the first slash, backslash, question mark or number
 * sign, and that delimiter, which must be there, makes the address a URL-like one: a slash or a backslash, a query that
 * starts with a name and an equals sign, or a number sign with an equals sign later in the run. The text after the
 * last "@" up to the delimiter must be a host name (isBareHostText). The user information is the text between the
 * colon and that "@", and it must not be empty.
 *
 * Not a span, so shown as written: a special scheme (https:user@host/ is masked by the other rules), a scheme of
 * ADDRESS_SCHEMES, a label that follows a slash (the authority rules read //name:secret@host/), an address that
 * no delimiter follows, as in "Contact:jane@example.com", and a question mark or a number sign that is not followed by
 * a value, as in "Did you mean To:jane@example.com?". "label:jane@example.com" with no space is therefore shown
 * unless a path, a query value or a fragment value follows, because text alone cannot tell a label from a user name.
 * A failed candidate is scanned to its own delimiter and a found one to its "@", so the scan stays linear. The result
 * is a display aid and is never part of a comparison key.
 */
export function findBareUserinfoSpans(source: string): UserinfoSpan[] {
  const spans: UserinfoSpan[] = [];
  // A tab right after the colon belongs to the user information, as it does after "://" (the other white space ends
  // the run). The tab is read as a letter, which keeps every position, so the spans index the source text.
  const text = source.includes(':\t') ? source.replace(/:\t/g, ':a') : source;
  const runs = new RegExp(RUN.source, RUN.flags);
  for (let run = runs.exec(text); run !== null; run = runs.exec(text)) {
    const s = run.index;
    const e = s + run[0].length;
    if (!run[0].includes('@')) continue;
    let lastEquals = e - 1;
    while (lastEquals >= s && text.charCodeAt(lastEquals) !== 0x3d) lastEquals--;
    let i = s;
    while (i < e) {
      if (!isLetter(text.charCodeAt(i)) || (i > s && isSchemeChar(text.charCodeAt(i - 1)))) {
        i++;
        continue;
      }
      let b = i;
      while (b < e && isSchemeChar(text.charCodeAt(b))) b++;
      if (b + 1 >= e || text.charCodeAt(b) !== 0x3a) {
        i = b;
        continue;
      }
      let k = b + 1;
      let lastAt = -1;
      while (k < e) {
        const c = text.charCodeAt(k);
        if (c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23) break;
        if (c === 0x40) lastAt = k;
        k++;
      }
      let ok = k < e && lastAt > b + 1 && isBareHostText(text, lastAt + 1, k);
      if (ok) {
        const d = text.charCodeAt(k);
        if (d === 0x3f) {
          let q = k + 1;
          while (q < e && isParamChar(text.charCodeAt(q))) q++;
          ok = q > k + 1 && q < e && text.charCodeAt(q) === 0x3d;
        } else if (d === 0x23) ok = lastEquals > k;
      }
      if (ok) {
        const prev = i > s ? text.charCodeAt(i - 1) : -1;
        ok = prev !== 0x2f && prev !== 0x5c && specialSchemeLength(text, i, e) !== b - i && !ADDRESS_SCHEMES.has(text.slice(i, b).toLowerCase());
      }
      if (ok) {
        spans.push({ start: i, from: b + 1, at: lastAt });
        i = lastAt + 1;
      } else i = k;
    }
  }
  return spans;
}

/** Masks the user information of every "label:name@host/path" that findBareUserinfoSpans finds, and leaves the label,
 * the host and the rest as they are: user:secret@host.example/p?x=1 reads user:***@host.example/p?x=1. Display only. */
export function maskBareUserinfo(text: string): string {
  if (!text.includes('@')) return text;
  const spans = findBareUserinfoSpans(text);
  if (spans.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.from) + '***@';
    pos = s.at + 1;
  }
  return out + text.slice(pos);
}

/** The spans of findBareUserinfoSpans for a source text, with the characters that stripControlChars removes read as
 * a letter, which keeps every position and does not end a run or a label. */
export function bareUserinfoSpansOf(text: string): UserinfoSpan[] {
  return findBareUserinfoSpans(text.replace(CONTROL_CHARS, (m) => 'a'.repeat(m.length)));
}

/** Masks user information, query values and fragments of every URL-like run in a piece of report text.
 * maskParenUserinfo and maskAuthorityUserinfo run first, for the shapes the runs of RUN cannot see as one URL, and
 * maskBareUserinfo for the name:secret@host shape without a scheme separator. stripControlChars runs last so a raw
 * ANSI escape from a compared page or an argument cannot reach a plain --format text report (0.2.16, found by an
 * outside review 2026-09-28). */
export function redactText(text: string): string {
  // The control characters go first as well as last: a vertical tab, a form feed, U+2028 or U+0085 inside the user
  // information would otherwise end the authority for the masking and be removed afterwards, which left a credential
  // that read as a whole URL.
  // maskMovedUserinfoTokens runs before the run-based masking, which rewrites an address and so would reformat
  // https://CORP\erik:secret@host/x into https://corp/erik:secret@host/x before any rule could read what was written.
  return stripControlChars(rewriteUrlRuns(maskBareUserinfo(maskAuthorityUserinfo(maskMovedUserinfoTokens(maskParenUserinfo(stripControlChars(text))), true)), maskHref));
}

/**
 * Every token of a report text that movedUserinfoMask reads as hiding user information is shown as that function shows
 * a link target (0.2.43, PF1 and K2-F5 of the second outside masking run): a token is the text between white space,
 * angle brackets and double quotes, without the opening brackets and quotes and the closing brackets, quotes and
 * punctuation around it. Before, only link targets had these rules, so the same address that a link finding showed
 * as https://*** stood whole in an excerpt, a message or the text of a link. A password that holds white space cannot
 * be read from one token: it is masked here only in the forms with "://" or a leading "//", which the user
 * information rules of maskAuthorityUserinfo find. A token that overlaps a user information that those rules or
 * maskBareUserinfo find in the whole text, such as postgres://user:secret@host/db, https://"admin":secret@host/ or
 * user:secret@host.example/p, is left to them, so the documented shapes keep their output. Display only.
 */
export function maskMovedUserinfoTokens(text: string): string {
  if (!text.includes('@')) return text;
  let own: UserinfoSpan[] | null = null;
  let bare: UserinfoSpan[] | null = null;
  // A tab right after a colon does not end the token, as it does not end the user information (findBareUserinfoSpans).
  return text.replace(/(?:[^\s<>"]|(?<=:)\t)+/gu, (token, offset: number) => {
    if (!token.includes('@')) return token;
    const [lead, end] = tokenCore(token);
    const core = token.slice(lead, end);
    const shown = movedUserinfoMask(core);
    if (shown === null || !credentialShaped(core)) return token;
    own ??= findUserinfoSpans(text, true);
    bare ??= findBareUserinfoSpans(text);
    // Left to those rules only when one of them ends at the last "@" of the token, so that it masks as far as this one
    // would; https://erik@corp:secret#x@host/ has a span that ends at its first "@" and is masked here.
    const lastAt = offset + token.lastIndexOf('@');
    if (spanEndsAt(own, lastAt) || spanEndsAt(bare, lastAt)) return token;
    // The word in front of the colon keeps the case it was written in: only the link-target reading lower-cases it.
    const word = /^[a-z][a-z0-9+.-]*/i.exec(core);
    const shownCased = word !== null && shown.startsWith(word[0].toLowerCase() + ':') ? word[0] + shown.slice(word[0].length) : shown;
    return token.slice(0, lead) + shownCased + token.slice(end);
  });
}

/** Whether the text before the last "@" of a token, after a scheme word, holds a colon or a backslash, a question mark
 * or a number sign: running text shows "https:example.com/@user/post" and "see:the@docs" as they are, where a link
 * target of the same shape is masked, because a target is never prose. */
function credentialShaped(core: string): boolean {
  const word = /^[a-z][a-z0-9+.-]*:/i.exec(core);
  const from = word === null ? 0 : word[0].length;
  const between = core.slice(from, core.lastIndexOf('@'));
  return between.includes(':') || (core.length > 1 && /[#?\\]/.test(between));
}

/** Whether one of the sorted, disjoint spans ends at the "@" at position at. */
function spanEndsAt(spans: UserinfoSpan[], at: number): boolean {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.at < at) lo = mid + 1;
    else hi = mid;
  }
  return spans[lo]?.at === at;
}

/** The part of a token that maskMovedUserinfoTokens reads: [first, end) without the opening brackets and quotes and
 * the closing brackets, quotes and punctuation. */
function tokenCore(token: string): [number, number] {
  let lead = 0;
  while (lead < token.length && "'([{".includes(token[lead]!)) lead++;
  let end = token.length;
  while (end > lead && ")']}.,;!".includes(token[end - 1]!)) end--;
  return [lead, end];
}

/** The tokens of a source text that maskMovedUserinfoTokens would replace, as spans whose `from` is the first character
 * and `at` the last one, for the position test of insideUserinfoSpan: a link that a Markdown parser reads out of such
 * a token, such as the e-mail address in ":secret@host.example/x", is shown masked. The characters that
 * stripControlChars removes are read as a letter, which keeps every position. */
export function movedUserinfoSpansOf(text: string): UserinfoSpan[] {
  const spans: UserinfoSpan[] = [];
  if (!text.includes('@')) return spans;
  const plain = text.replace(CONTROL_CHARS, (m) => 'a'.repeat(m.length));
  const tokens = /[^\s<>"]+/gu;
  for (let t = tokens.exec(plain); t !== null; t = tokens.exec(plain)) {
    const token = t[0];
    if (!token.includes('@')) continue;
    const [lead, end] = tokenCore(token);
    if (movedUserinfoMask(token.slice(lead, end)) === null) continue;
    spans.push({ start: t.index + lead, from: t.index + lead, at: t.index + end - 1 });
  }
  return spans;
}

/**
 * The text with the parts that maskHref hides taken out of every URL-like run: user information, query values
 * and the fragment. Nothing else moves, and nothing is normalized, so every other number stays as it was.
 */
export function hideUrlSecrets(text: string): string {
  // maskParenUserinfo runs first, the same order redactText uses, so a numeric password in the
  // parenthesized-userinfo shape cannot reach extractNumbers as plain text (P-N1, found by an outside
  // review 2026-09-28): up to here only redactText applied it, so visibleNumbers below still read a
  // number straight out of an unmasked "(name):secret@" that the general run-based scan cannot see as
  // one run (see the comment on PAREN_USERINFO_START above).
  // The forms that redactText masks with the reading of a link target, and the scheme-less name:secret@host, are taken
  // out too (0.2.43, QA-2 D1): a password of digits only inside them would otherwise be read as a number and reach
  // NUMBER_CHANGED. White space inside the user information stays out of this reading, as above.
  return rewriteUrlRuns(maskBareUserinfo(maskAuthorityUserinfo(maskMovedUserinfoTokens(maskParenUserinfo(text)), true)), withoutUrlSecrets);
}

/**
 * The numeric tokens a report may show. extractNumbers reads the whole text, so a numeric query value, such as
 * an access token in a link printed on the page, is among them, and the recursive report redactor does not
 * recognise a bare number as part of a URL. A value is reported only when it survives the URL masking (found
 * by an outside review 2026-09-22).
 */
export function visibleNumbers(text: string): string[] {
  return extractNumbers(hideUrlSecrets(text));
}

/** An href with only the characters the URL standard strips from its ends removed: the C0 controls and the space
 * (U+0000 to U+0020). JavaScript's trim() also removes the no-break space, the ideographic space and the other
 * Unicode spaces, which the URL parser keeps as part of the address, so a target that differs by one of them
 * compared equal (MP-16). */
export function trimHref(href: string): string {
  let start = 0;
  let end = href.length;
  while (start < end && href.charCodeAt(start) <= 0x20) start++;
  while (end > start && href.charCodeAt(end - 1) <= 0x20) end--;
  return href.slice(start, end);
}

/** The longest link target the comparison accepts, in characters of the href as the page or the Markdown wrote it.
 * Up to 0.2.38 the length had no bound, and the time of the comparison grew with the length times the number of
 * links, blocks or references that handle it again (minutes for a few thousand links against a 100 000 character
 * target). 8192 is the longest request line the Apache default accepts and is far above any link a page needs;
 * a data: URI longer than this is not a link a reader follows. */
export const MAX_LINK_TARGET_CHARS = 8192;

/** A link target is longer than MAX_LINK_TARGET_CHARS. It names the length and never repeats the target. */
export class LinkTargetError extends Error {
  constructor(readonly length: number) {
    super(`A link target is ${length} characters long, more than the limit of ${MAX_LINK_TARGET_CHARS}; the comparison was not run.`);
    this.name = 'LinkTargetError';
  }
}

/** Resolves a possibly relative href against a base. Returns null when it cannot be resolved. Throws a
 * LinkTargetError for a target longer than MAX_LINK_TARGET_CHARS. */
export function resolveHref(rawHref: string, base: string | null): string | null {
  if (rawHref.length > MAX_LINK_TARGET_CHARS) throw new LinkTargetError(rawHref.length);
  const href = trimHref(rawHref);
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

/** Masks query values, drops the fragment and removes user information for display in reports and logs.
 * Never returns the raw query or the credentials of an unparseable input either. */
export function maskUrl(url: string): string {
  return maskHref(url);
}

/** Masks query values, drops the fragment and removes user information of an absolute or relative href for
 * display. The user name goes with the password, because either one can be the secret. Up to 0.2.9 both
 * stayed in the output, and so in the error of a refused URL (found by an outside review 2026-09-22). */
export function maskHref(href: string): string {
  try {
    const u = new URL(href);
    u.username = '';
    u.password = '';
    // One pass: a Set keeps the first-seen key order and merges duplicates, and the
    // masked query is built once with append. Calling searchParams.set for each key re-serializes the whole query
    // every time, which is quadratic in the number of keys (20 000 keys took tens of seconds). An empty
    // query is left as it is, so "?" stays "?".
    const maskedQuery = new URLSearchParams();
    for (const key of new Set<string>(u.searchParams.keys())) maskedQuery.append(key, '***');
    if (maskedQuery.toString() !== '') u.search = maskedQuery.toString();
    u.hash = '';
    return u.href;
  } catch {
    // Relative, protocol-relative or unparseable: mask by hand.
    const plain = withoutUserinfo(href);
    const hashAt = plain.indexOf('#');
    let h = hashAt >= 0 ? plain.slice(0, hashAt) : plain;
    const q = h.indexOf('?');
    if (q >= 0) {
      const params = h.slice(q + 1).split('&').map((kv) => (kv === '' ? kv : `${kv.split('=')[0]}=***`));
      h = `${h.slice(0, q)}?${params.join('&')}`;
    }
    return h;
  }
}

const SPECIAL_SCHEMES = new Set(['ftp', 'file', 'http', 'https', 'ws', 'wss']);

/** Leading characters a reader does not see but the URL parser keeps: the Unicode white space, U+0085, U+180E,
 * U+200B and U+FFFD, which the Markdown parser writes for a NUL. */
const EDGE_INVISIBLE = new RegExp('^[\\s' + String.fromCharCode(0x85, 0x180e, 0x200b, 0xfffd) + ']+');

/**
 * What a report shows in place of a link target whose user information the URL parser and a person may read at
 * different places, or null when maskHref and maskBareUserinfo show the target safely. It is decided from the written
 * target alone, whatever the base, so one link reads the same in every finding, the way turva-llms-txt-validator
 * shows an ambiguous address: only the scheme and "//***", or "***" when the text before the colon may itself be the
 * user name. Found by an outside fuzz run of 0.2.40 on 2026-11-22 (P3-1) and by four independent checks of 0.2.41
 * before release. Only a target that holds an "@" counts, and these shapes are masked:
 *
 * - a special scheme with fewer than two slashes or backslashes after its colon, as in `https:/user:secret@host/x`.
 *   Against a base of the same scheme the parser reads a relative path, so `https://example.com/user:secret@host/x`
 *   was shown.
 * - an authority, after two slashes (or backslashes, for a special scheme or no scheme), with a backslash, "?" or "#"
 *   before the last "@" and before the first "/", as in `https://CORP\erik:secret@host/x` or
 *   `https://user:x?secret@host/x`. The parser ends the host there, so the secret was shown in a path or as a query
 *   name. `https://example.com?e=a@b.com` reads the same way and is masked too.
 * - an authority that the parser refuses, as with the port `pa` in `https://user:pa/ss?secret@host`.
 * - a `file:` URL. Its host is empty, so `file:///user:secret@host` kept the user information in its path.
 * - a non-special scheme with no "//", or with an empty authority as in `gopher:///user:secret@host`, whose text
 *   before the last "@" holds a colon, as in `gopher:user:secret@host`, which the parser reads as an opaque path. Not
 *   for an address scheme such as mailto, and not for `user:secret@host.example/p`, whose user name is the scheme
 *   word and which maskBareUserinfo masks.
 * - a scheme word that the parser refuses, as in `user_name:secret@host`, `my_app:user:secret@host` or
 *   `ht tps:/user:secret@host`, which resolves as a relative path.
 * - any target with an "@" after a leading Unicode space or U+FFFD, which the parser keeps, so it reads the whole
 *   target as a relative path. Only *** is shown then.
 * - a relative target with a "?" or "#" before its last "@" and a colon between them, as in `u?x:secret@host`,
 *   which put the secret into a query name. Only *** is shown.
 * - a relative target with no "/" before its last "@" and a colon before that "@", when no scheme word stands before
 *   the colon: a Windows domain user as in `CORP\erik:secret@host/p`, an empty user name as in `:secret@host/p` and an
 *   "@" in the user name as in `erik@:secret@host/p`. The parser resolves each of them as a path, and maskBareUserinfo
 *   needs a label. Only *** is shown (independent rerun of 0.2.41, 2026-11-22).
 *
 * Not masked, and named in the README: a password that starts with "/" or with digits and "/", as in
 * `https://user:/secret@host`, which the parser reads as a host, a port and a path and which text alone cannot tell
 * from a path that holds an "@", such as `https://localhost:8080/team@example.com`; and a relative path such as
 * `/user:secret@host`, which both readers take as a path.
 */
export function movedUserinfoMask(written: string): string | null {
  const own = urlParserInput(written);
  const h = own.replace(EDGE_INVISIBLE, '');
  if (!h.includes('@')) return null;
  // A leading invisible character makes the parser read the whole target as a relative path, whatever follows it, so
  // nothing of it is shown (fifth independent check: U+2003 before user:secret@host/p or https:///user:secret@host).
  if (h !== own) return '***';
  // The scheme word runs to the first colon unless a slash, backslash, ?, # or @ comes first, so "ht tps:" is a word
  // the parser refuses, not a relative path (fifth check).
  const word = /^([^\/\\?#@:]+):/.exec(h);
  if (word !== null && !/^[a-z][a-z0-9+.-]*$/i.test(word[1]!)) return '***';
  const name = word === null ? '' : word[1]!.toLowerCase();
  if (ADDRESS_SCHEMES.has(name)) return null;
  const special = word === null || SPECIAL_SCHEMES.has(name);
  const rest = word === null ? h : h.slice(word[0].length);
  const shown = word === null ? '//***' : `${name}://***`;
  const isSlash = (c: number) => c === 0x2f || (special && c === 0x5c);
  if (!(rest.length >= 2 && isSlash(rest.charCodeAt(0)) && isSlash(rest.charCodeAt(1)))) {
    if (word === null) {
      // A relative target with a ? or # before its last @ and a colon between them, as in u?x:secret@host, put the
      // secret into a query name against a base (fifth check), so nothing of it is shown.
      const lastAt = h.lastIndexOf('@');
      const cut = h.search(/[?#]/);
      if (cut >= 0 && h.slice(cut, lastAt).includes(':')) return '***';
      // A colon before the last @ and no slash before it, with no scheme word in front of the colon: CORP\erik:secret@,
      // :secret@ and erik@:secret@ resolved as a path and were shown whole (n3 to n5 of the rerun of 0.2.41).
      const before = h.slice(0, lastAt);
      return before.includes(':') && !before.includes('/') ? '***' : null;
    }
    if (special) return shown;
    const before = rest.slice(0, rest.lastIndexOf('@'));
    if (before.includes(':')) return `${name}:***`;
    // user:secret#x@host.example/p, user:ab?secret@host/p, user:secret x@host/p and user:secret\x@host/p: the secret
    // stands in front of a delimiter that ends the span maskBareUserinfo reads, so only the scheme word is shown, as
    // for a colon in the user information (0.2.43, PL1 and PF3 of the second outside masking run). A one-letter
    // word is a drive letter, as in C:\dir\file@2x.png, and stays.
    if (name.length > 1 && /[\s#?\\]/.test(before)) return `${name}:***`;
    return null;
  }
  if (name === 'file') return shown;
  // A non-special scheme with an empty authority, as in gopher:///user:secret@host, keeps the rest in its path.
  if (!special && rest.charCodeAt(2) === 0x2f) return `${name}:***`;
  let k = 2;
  while (k < rest.length && isSlash(rest.charCodeAt(k))) k++;
  const tail = rest.slice(k);
  const lastAt = tail.lastIndexOf('@');
  if (lastAt <= 0) return null;
  const slash = tail.indexOf('/');
  const end = slash >= 0 && slash < lastAt ? slash : lastAt;
  if (/[\\?#]/.test(tail.slice(0, end))) return shown;
  try {
    new URL(word === null ? `https:${h}` : h);
  } catch {
    return shown;
  }
  return null;
}

/**
 * Marks the links of the blocks whose written target is relative, when the base they were resolved against hides user
 * information: either baseMasked says so (a base that a redirect with such a Location produced) or movedUserinfoMask
 * reads the base itself as one of its shapes, as in `https://CORP\erik:secret@host/dir/`. The parser reads that base
 * as host "corp" and the user information as its path, so every relative link resolved against it carried the secret,
 * and a report showed it (n6 of the rerun of 0.2.41, 2026-11-22). A marked link is shown as it was written, not as it
 * was resolved. Display only: the comparison keeps the resolved target.
 */
export function markBaseMaskedLinks(blocks: ReadonlyArray<{ links: Array<{ rawHref: string; baseMasked?: boolean }> }>, bases: ReadonlyArray<string | null | undefined>, baseMasked: boolean): void {
  if (!baseMasked && !bases.some((b) => typeof b === 'string' && movedUserinfoMask(b) !== null)) return;
  for (const block of blocks) {
    for (const link of block.links) {
      let absolute = false;
      try {
        absolute = resolveHref(link.rawHref, null) !== null;
      } catch {
        absolute = false;
      }
      if (!absolute) link.baseMasked = true;
    }
  }
}

/**
 * The href without its user information. The authority is found where the URL parser looks for it: after
 * "scheme:" and any slashes or backslashes for a special scheme, after "//" for any other scheme, and after two
 * slashes or backslashes when there is no scheme, because a relative reference in a web page resolves against
 * an http or https base. When the parser reads the address, the user information ends at the last '@' before
 * the authority ends, so an '@' in a path stays. When the parser refuses the address, nothing tells which '@'
 * ends the user information, so everything up to the last '@' before the query or the fragment is shown as ***.
 * The mask is visible on purpose. Three review rounds on 2026-09-22 measured every rule that guessed: stopping
 * at the first slash returned a password that holds a slash, reading to the last '@' made a host vanish without
 * a trace, and telling user:password from host:port by the digits did both. The
 * string is first read the way the parser reads it (urlParserInput), so a tab or newline cannot hide a
 * delimiter.
 */
function withoutUserinfo(href: string): string {
  const h = urlParserInput(href);
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(h);
  const special = scheme === null || SPECIAL_SCHEMES.has(scheme[0].slice(0, -1).toLowerCase());
  const isSlash = (c: number) => c === 0x2f || (special && c === 0x5c);
  const from = scheme ? scheme[0].length : 0;
  let j = from;
  while (j < h.length && isSlash(h.charCodeAt(j))) j++;
  const hasAuthority = scheme === null ? j - from >= 2 : special || h.startsWith('//', from);
  if (!hasAuthority) return href;
  if (scheme !== null && !special) j = from + 2;
  let parsed: URL | null = null;
  try {
    parsed = new URL(h, scheme === null ? 'https://base.invalid/' : undefined);
  } catch {
    parsed = null;
  }
  let at = -1;
  for (let k = j; k < h.length; k++) {
    const c = h.charCodeAt(k);
    if (c === 0x3f || c === 0x23 || (parsed !== null && isSlash(c))) break;
    if (c === 0x40) at = k;
  }
  if (at < 0) return href;
  return h.slice(0, j) + (parsed === null ? '***@' : '') + h.slice(at + 1);
}

/** The URL-like string with what maskHref hides taken out: user information, query values and the fragment.
 * Query names stay, as they do in maskHref. */
function withoutUrlSecrets(url: string): string {
  let h = withoutUserinfo(url);
  const hashAt = h.indexOf('#');
  if (hashAt >= 0) h = h.slice(0, hashAt);
  const q = h.indexOf('?');
  if (q < 0) return h;
  const params = h.slice(q + 1).split('&').map((kv) => {
    const eq = kv.indexOf('=');
    return eq < 0 ? kv : kv.slice(0, eq + 1);
  });
  return `${h.slice(0, q)}?${params.join('&')}`;
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
