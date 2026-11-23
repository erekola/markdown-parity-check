# markdown-parity-check

A command-line tool and TypeScript library that compares the main content of a page's HTML and Markdown versions. The report lists blocks that are missing, added or changed, and numbers and links that differ, each with its source location. It can request both versions of one URL or read two local files.

## Install

The package needs **Node.js 22 or newer**. It is MIT licensed. GitHub Actions tests Node.js 22, 24 and 26 on Windows and Ubuntu.

Run it without installing anything:

```sh
npx --yes markdown-parity-check --url https://example.com/page
```

Install the CLI globally, or add it to a project as a library:

```sh
npm install -g markdown-parity-check
npm install markdown-parity-check
```

## Try it in the browser

The [hosted Markdown parity check](https://turva.dev/markdown-parity-check) runs this comparison on turva.dev. It currently checks published turva.dev pages only, except the two tool pages, and the page states that limit in its first two paragraphs and again at the address field. An address on any other site is refused with a message that points to the command-line tool.

The Fill in an example button puts turva.dev's own tools page in the address field, and the Check button runs the comparison as a separate step.

## Check your own site

Replace the address with your page. The tool requests it twice, with `Accept: text/html` and with `Accept: text/markdown`. If the Markdown has its own address, add `--markdown-url`:

```sh
npx --yes markdown-parity-check --url https://example.com/page --markdown-url https://example.com/page.md
```

In CI, write the JSON report to a file and let warnings fail the step as well:

```sh
npx --yes markdown-parity-check --url https://example.com/page --format json --output report.json --strict
```

To compare two local files, pass both and a base URL for their relative links:

```sh
npx --yes markdown-parity-check --html-file page.html --markdown-file page.md --base-url https://example.com/page
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The comparison completed without a rejecting finding. |
| `1` | The comparison completed and found rejecting content or delivery differences. |
| `2` | An input, fetch, parse or report error prevented a reliable comparison. A standard output that is closed before the report is written also gives 2. |

Exit code 0 means the implemented checks found nothing to reject. It does not prove that the two versions mean the same thing.

### Options

| Option | Purpose |
| --- | --- |
| `--url URL` | Request both versions from one URL. |
| `--markdown-url URL` | Request the Markdown from a separate address. Needs `--url`. |
| `--html-file PATH --markdown-file PATH` | Compare two local files instead. |
| `--base-url URL` | Resolve relative links in local files. Local-file mode only. |
| `--selector CSS` | Choose the HTML content container. Several matches give a note and the first in document order is used. No match is an error and ends the run with exit code 2. |
| `--html-profile generic` or `--html-profile starlight` | Use the generic HTML rules, which is the default, or the Starlight rules, which also compare inactive tab panels and keep Expressive Code line breaks. |
| `--front-matter keep` or `--front-matter strip` | Keep Markdown front matter, which is the default, or remove it before the comparison. |
| `--format text` or `--format json` | Print a readable report, which is the default, or a structured one. |
| `--output PATH` | Write the report to a file. An input file is never overwritten. |
| `--strict` | Treat warnings as rejecting findings. |
| `--timeout-ms MS` | Deadline for each request and for the parsing and comparison step. The default is 15 000 ms, and a run that passes it stops with exit code 2. The value must be a positive decimal integer no greater than 2147483647. |
| `--max-bytes N` | Limit on decoded bytes per response. The default is 5 MiB. The value must be a positive decimal integer no greater than 9007199254740991. |
| `--help`, `-h` | Print the help. |
| `--version`, `-V` | Print the version. |

A value that is outside these ranges, or that is not a plain run of digits, stops the run with exit code 2 and an error message.

### Example output

This is the text report for the matching fixture pair in this repository, run with version 0.2.43 on 2026-11-23. The exact command is in the Development section below. The text report ends with a list of limitations, which is omitted here:

```text
markdown-parity-check 0.2.43 (offline mode)
Result: PASS (0 error(s), 0 warning(s), 1 info)

HTML:     test/fixtures/same/page.html (file, 1,017 bytes, base https://example.com/page)
Markdown: test/fixtures/same/page.md (file, 514 bytes, base https://example.com/page)
Extraction: HTML via main (high confidence), 9 block(s); Markdown 9 block(s).
  note: Front matter (3 lines) was stripped as requested (--front-matter strip).
Coverage: 9/9 HTML block(s) aligned (100 %), 9/9 Markdown block(s) aligned (100 %).

Findings (1):
  1. [info] MARKDOWN_FRONT_MATTER_STRIPPED: Lines 1-3 were stripped as front matter (--front-matter strip) and not compared.
       Markdown  line 1  "title: Agent readiness audit"
```

## What is compared

### The HTML container

Without `--selector`, the tool looks for a visible `main`, then a visible `article`, then a visible `[role=main]`, and uses the first match of the first kind that has one.

- A candidate is visible when neither it nor an ancestor is hidden, in a template or inside one of the left-out subtrees listed below. An `article` inside a `nav` is therefore not used.
- A `form` is the one exception, so a `main` inside a `form` that has no left-out role is still used, however far up the form sits.
- If none of them exists, the page body is used and the report warns that page chrome may leak in. A source with no `<body>` element written in it that has none of them ends with the error `Document has no <body> element.` and exit code 2.
- Two visible elements of the same kind that do not contain one another also give a warning, because only the first is compared.

Front matter is kept by default and compared as content. If the HTML does not carry the same text, that alone fails the comparison. The tool also warns when the Markdown starts with a block that looks like YAML front matter, and `--front-matter strip` removes it.

### Blocks and severities

Headings, paragraphs, list items, tables, code blocks and links are compared block by block. A link that wraps block elements, such as a linked card with a heading and a paragraph, is compared as those blocks. Each keeps its own type and heading level and carries the link. The Markdown side is read the same way, so `## [Title](url)` is a heading with a link. In a table cell the link is read as part of the cell text.

Content that is hidden or sits inside a left-out element is left out on both sides. This also holds when the raw HTML wrapper, such as `<div hidden>` or `<nav>`, is opened in one Markdown block and closed in a later one. A table caption counts as a paragraph before the table.

Hidden means the `hidden` attribute, `aria-hidden="true"` and a `template` element, whose content a browser never renders. An element with `aria-hidden="true"` counts as hidden although a sighted reader still sees it, so text that only the HTML carries inside such an element is not reported as missing from the Markdown. The `starlight` profile compares the title of a Starlight aside although it carries `aria-hidden="true"`, as [docs/starlight.md](https://github.com/erekola/markdown-parity-check/blob/main/docs/starlight.md) describes. A style that hides an element, such as `display: none`, is not evaluated, because CSS is not read. In the Markdown, an HTML comment and an unused link reference definition, which is one that no link uses, are not content and give no finding, not even with `--strict`. A definition that a link uses is compared through that link.

- Errors: missing and added blocks, a change in text or numbers, a changed table or link, and a list item that shows another number or a different checked or unchecked state.
- Warnings: a relative link target that differs in text while no `--base-url` is known, so the two forms cannot be confirmed equal or different, which fails a `--strict` run, a raw HTML block in the Markdown whose text could not be parsed into blocks and so was not compared, a checkbox that is present on one side only, a difference in order and a difference in heading level, case, punctuation, list kind or nesting level. A difference in order is also reported for a block that moved and changed only in case, punctuation or typographic characters. A block that moved and also changed in its words or numbers gets the finding for that change and no order finding. A changed accent mark, vowel sign, symbol or emoji is a change in text and not in punctuation, so it is an error. A swapped symbol is an error also when a reader sees the same meaning. Examples are an ASCII arrow made of a hyphen and a greater-than sign against an arrow character, or a dropped trademark sign. An invisible variation selector alone is not. Each footnote in the Markdown is a warning, because footnotes are not compared. These are the main cases, and the `code` of each finding names the exact rule. A missing or extra copy of a repeated block is reported as a missing or added block, which is an error.
- Information: a skipped comparison of a reversed list or of a table with spans, a raw HTML block that was parsed, and front matter that was stripped. None of them fails a check, not even with `--strict`.

The cell-by-cell comparison of a table is skipped when one of its cells has a rowspan or colspan above 1, a rowspan of 0, or a value that is empty or does not begin with a number. The number is read with `parseInt`, so leading white space, a no-break space included, and a plus or minus sign are accepted, `2abc` counts as 2, and a negative value is not above 1. A colspan of 0 and a rowspan or colspan of 1 do not trigger it. The links and the caption of such a table are still compared. The numbering of a reversed list is not compared either.

### Content that is left out

Some content is left out even when it sits inside the main content, in code blocks too. These are the subtrees of:

- `form`, `button`, `input`, `select`, `textarea`, `dialog`, `iframe`, `svg`, `canvas`, `object`, `embed` and `map`.
- `nav`, `script`, `style`, `noscript` and `template`.
- Any element with the role `navigation`, `banner`, `contentinfo`, `complementary`, `search`, `menu`, `menubar` or `dialog`. The `role` attribute is read as a list of tokens, and the first token that names a role of WAI-ARIA 1.2 decides, so `role="navigation foo"` and `role="foo navigation"` count, and so does `role="doc-toc navigation"`, because `doc-toc` is not in that list. A page whose whole content sits in such an element ends with the error `HTML main content is empty` and exit code 2. The `[role=main]` candidate for the content container stays an exact match.
- A `header` or `footer` that sits directly under `body` or `html`, unless it is the content container itself.

The `starlight` profile keeps an iframe that has a source and a title, as a link. The same list applies to inline raw HTML in the Markdown and to the checkbox of a task list item, which must belong to the item itself.

A left-out tag in a Markdown paragraph, such as a `<button>` or a `<script>`, is skipped through its matching closing tag in the same paragraph. Inside a paragraph, a left-out tag with no closing tag is reported as a warning and its text is compared as visible.

A left-out wrapper such as `<nav>` or `<form>` that is opened in its own Markdown block and never closed hides every block after it, the way an unclosed element does in HTML. A Markdown document left with no content ends with exit code 2. The void tags `input` and `embed` need no closing tag and are skipped on their own. A self-closing `<svg/>` counts as closed by itself, as in HTML, and `<button/>` does not.

A `<br>` in a code block is a line break. A code block that differs only in whitespace is a warning, where whitespace means the ASCII whitespace characters and the Unicode space separators such as the no-break space. Any other difference in code, an invisible character such as a soft hyphen included, is an error. An image is compared by its alt text only, not by its address, so two different images with the same alt text compare equal.

### Delivery in URL mode

In URL mode the Markdown response is checked first. An HTTP error or an HTML page in place of Markdown fails the check, and nothing is compared. A Markdown response labelled `text/plain` is a warning, and any other content type than `text/markdown` or `text/x-markdown` is an error. A comment, an XML declaration or another declaration before the doctype does not hide an HTML page from this check. Only a response that starts with `<!doctype html` or `<html` counts as an HTML page here. A fragment that starts with `<body>` or another tag is compared as Markdown, and its raw HTML gives an information finding. If the HTML request itself returns an HTTP error, the run ends with exit code 2.

A response whose Content-Type header names `text/html` or `application/xhtml+xml` is decoded by its byte order mark first, then by the charset of that header, then by a meta charset declaration in its first 1024 bytes. It is decoded as UTF-8 when none of them names a known encoding.

The choice follows the type of the response, not the request. Any other response, including an HTML page sent with another type or with no Content-Type header, is decoded by the charset of its header or as UTF-8. Its byte order mark and meta declaration do not choose the encoding. A Markdown response is decoded that way too.

### Limits of the method

JavaScript is not executed. Content that a page builds in the browser is compared as the server sent it. Block matching is heuristic, so some layouts need an explicit selector. Reports mask URL query values and fragments and remove the user name and password of an address with a scheme, such as `https://user:password@host/`. Excerpts may still contain private page content. Review a report before you share it.

The masking is a display safeguard. It reads text by its shape and not by its meaning, so text that reads as user information is masked even when it is prose: `Meet 10:30@venue ok` is shown as `Meet *** ok`, `std::vector@x` as `std:***`, and a paragraph that starts with `// TODO:fix mail me@x.org` is shown as `//x.org`, because a `//` starts a network-path reference. It changes what a report shows and never what is compared, and a number difference inside a masked part still gives the number finding, with the values left out. The paragraphs below say what is masked and what is shown.

It removes the user name and password even when a tab, a line break or a space sits inside the user information, provided that the user information holds a colon, as in `user:password`. A user name alone, with no colon, is masked when a tab, a vertical tab or a form feed sits inside it, and is shown when a space, a no-break space, a line feed or a carriage return does, because a line break or a space between an address and an e-mail address is ordinary text. On a bare host name without a scheme, a query or a fragment is masked only when it holds an equals sign, so an anchor such as `example.com/docs/guide#step-3` and a path segment are shown. Not masked: a bracketed IPv6 host, a host with a trailing dot, a name with no dot other than `localhost` and an scp-style `git@host:path`. 

A scheme-less `user:password@host.example/path` is masked as `user:***@host.example/path`, and so is the e-mail link that the Markdown parser reads out of it, when a path, a query that holds a value or a fragment that holds an equals sign follows the host name. Without one, as in `user:password@host.example` or `Contact:jane@example.com`, it is shown, because text alone cannot tell a user name from a label. The scheme-less form is also shown when its host name holds a letter outside ASCII, or when its colon or at sign is written as a character reference or a fullwidth character. An address after `mailto:`, `xmpp:`, `sip:`, `sips:`, `acct:` or `im:` is shown as written. 

A link target that holds an `@` is shown as its scheme and `//***`, as `gopher:***` for a non-special scheme such as `gopher:`, or as `***`, when a URL parser and a person could read its user information at different places. A special scheme such as `https:` with fewer than two slashes or backslashes after its colon is one such case, as in `https:/user:password@host.example/x`. An authority with a backslash, a `?` or a `#` before its last `@` and before any `/` is another, as in `https://CORP\erik:password@host.example/x`, and `https://example.com?e=a@b.com` reads the same way. An authority that the URL parser refuses, as with the port in `https://user:pa/ss?password@host.example`, and a `file:` URL are masked as well. Masked too: a scheme that the parser refuses, as in `user_name:password@host.example`, and a non-special scheme such as `gopher:` whose text before the `@` holds a colon. A target without a scheme word before its colon that holds a colon and no `/` before its last `@`, as in `CORP\erik:password@host.example/x`, `:password@host.example/x` or `erik@:password@host.example/x`, is shown as `***`. When the text before the `@` of a non-special scheme word holds a number sign, a question mark, a space or a backslash, as in `user:pass#word@host.example/p`, the target is shown as `user:***`. One-letter words, drive letters as in `C:\dir\file@2x.png`, are not read this way. Each of these shapes is masked after a leading Unicode space or a NUL character too. 

A base address of these shapes, given as `--base-url` or written in a `<base href>`, as in `https://CORP\erik:password@host.example/dir/`, is shown as its scheme and `//***/`, and a relative link resolved against it is shown as written, not as resolved. In the URL mode, a followed redirect whose `Location` has one of these shapes makes the final address show as its scheme and `//***/`, in the report and in a fetch error, and the links resolved against it are shown as written. The `Location` header is read as UTF-8, as a browser reads it, so an ideographic space, a no-break space or U+FFFD that arrives as bytes at its start counts as a leading character, and the shapes above are masked behind it. A `--url` of these shapes, as in `http://host.example:8080\erik:password@other.example/p`, is masked the same way. The URL parser reads it as a host, a port and a path. A target of these shapes is shown this way also when it holds no user information, such as `file:///home/a@b.txt`. 

Report text is read the same way. A word of an excerpt, a message or a link text, which is the text between white space, angle brackets and double quotes, is shown as a link target of the same shape would be when the text before its last `@` holds a colon, a backslash, a question mark or a number sign, where the colon counts after the scheme word when there is one. So `https://CORP\erik:password@host.example/x` is shown as `https://***/`, and `DOMAIN\erik:password@host.example/p` and `:password@host.example/x` are shown as `***`. A word that the rules above for a scheme or a leading `//` already mask keeps the result of those rules, such as `user:***@host.example/p`. An error that repeats a value, such as the value of `--base-url`, `--timeout-ms` or `--html-file`, reads it as a link target first, so `ftp://corp.example\erik:password@host.example/` is shown as `ftp://***`. For a rejected `--selector` that holds an `@`, the message of the selector parser is never quoted, and the value that the error names is read in the same way, or shown as `***@` and the text after its last `@`. In report text the word in front of the colon keeps the case it was written in, so `Re:Re:@work` is shown as `Re:***`, where a link target shows a scheme word in lower case. 

Not masked: a password that starts with `/` or with digits and `/`, as in `https://user:/password@host.example`, which the URL parser reads as a host and a path and which text alone cannot tell from a path that holds an `@`, such as `https://localhost:8080/team@example.com`, and a relative path such as `/user:password@host.example`, which both readers take as a path. In Markdown a backslash before a punctuation mark stands for the mark, so `\/user:password@host.example` is that relative path too. A plain space, a no-break space or any other Unicode space right after the colon of the user information, such as U+3000, U+2003 or U+202F, and a password of digits only that is followed by white space, are read as text and shown. A tab right after the colon belongs to the user information and is masked in a link target, a message and an option value. In an excerpt it is shown, because the text of a block has turned the tab into a space by then. In running text a password that holds white space is masked only after `://` or after a leading `//`, with no backslash domain before the user name. Elsewhere the whole text is shown as written, so `user:pass word@host.example/p`, `user:password#a b@host.example/p`, `user:password?a b@host.example/p` and `user:password# x@host.example/p` in a paragraph are shown whole. A link target is read as a whole and has no such limit. 

In both formats U+200E, U+200F, U+061C, U+2028, U+2029 and the tag characters are removed from report text. The text report shows a line feed or a carriage return inside a string from a page or an argument as `\n` or `\r`.

A link target longer than 8192 UTF-16 code units stops the run with exit code 2 and an error that names the limit and does not repeat the target. The comparison handles a target once for every link, block or reference that touches it, so the time grew with the length of the target times that count. The limit applies to the target as the page or the Markdown wrote it, before any resolution.

## Command line and hosted page

Both use the comparison core of this package. They differ in which pages they reach and in their limits:

| Topic | Command-line tool | Hosted page |
| --- | --- | --- |
| Pages | Any public HTTP or HTTPS address, or two local files. | Published turva.dev pages only, except the two tool pages, this one and the llms.txt validator. |
| Fetching | Network requests from your machine. Non-public addresses are refused, also behind DNS and redirects. The tool connects directly to the validated address and does not use `HTTP_PROXY` or `HTTPS_PROXY`, so behind a mandatory proxy use the file mode. | The turva.dev Worker renders both versions itself, so a check sends no request over the network. |
| Response size | 5 MiB per response by default, adjustable with `--max-bytes`. | HTML up to 512 KiB. Markdown up to 128 KiB. |
| Comparison size | Up to 4 000 000 block pairs. | Up to 250 000 block pairs. |
| Rate | Not limited by the tool. | About 10 checks per minute from one IP address at each Cloudflare location. |

The hosted page also answers a JSON POST, described on the page. It runs the release of this package pinned in [turva-worker](https://github.com/erekola/turva-worker), which can be older than the latest npm release. The report's `toolVersion` field shows which release produced it.

Some limits are not in the table:

- A URL that contains a user name or password is refused even when its host is public, and the same holds for a redirect target.
- A host written as an IPv6 literal in brackets is checked against the same address policy as a resolved address and is not looked up in DNS.
- Of the IPv6 addresses, only the block 2000::/3, which is the global unicast space the IANA has allocated, can be public. Inside it the blocks that the IANA special-purpose registry does not mark as globally reachable are refused too. An address anywhere else, such as `8000::1` or `0:1::1`, is refused, with one exception: the forms that carry an IPv4 address are decided by that IPv4 address, as before. These are the IPv4-mapped form `::ffff:a.b.c.d`, the IPv4-translated form `::ffff:0:a.b.c.d`, the deprecated IPv4-compatible form `::a.b.c.d` and NAT64 `64:ff9b::a.b.c.d`, which all lie outside 2000::/3, and 6to4 and Teredo, which lie inside it. So `::ffff:8.8.8.8` and `64:ff9b::8.8.8.8` are public and `::ffff:127.0.0.1` is not.
- The tool sends `Accept-Encoding: gzip, deflate, br` and decodes responses with no Content-Encoding, `identity`, `gzip`, `x-gzip`, `deflate` or `br`. A response with any other Content-Encoding, `zstd` for example, is rejected, and the run ends with exit code 2.
- The command-line tool follows at most 5 redirects.
- When elements are nested more than 1024 levels deep, the extraction stops with exit code 2. This holds in the HTML page, in a raw HTML block written inside the Markdown, across raw elements left open between Markdown blocks or in the Markdown's own structure.
- The matching stops the same way when more than 1 000 000 similar block pairs would have to be considered. The library `limits` default to the same two values for block pairs and similar block pairs. `maxSimilarityWork` has no default bound.
- The hosted page uses lower nesting and matching limits: 512 levels and 50 000 similar block pairs.

A hosted check can fail on turva.dev's own pages as well. On 2026-09-11 the check of https://turva.dev/tools returned `fail` with five errors. The Markdown carries a Related heading and four links that the HTML page leaves out, and the report listed each of them. The same four targets are links inside that page's tool cards, so the report found a missing structure and not missing content. The page passed again on 2026-10-02. [HTML and Markdown can disagree](https://turva.dev/blog/html-and-markdown-can-disagree) reads that result in full.

## Use from Node and TypeScript

The package is an ES module written in TypeScript and ships its type declarations. The library entry exports the comparison without the command-line interface, the file reader or the network code. It imports no Node.js built-in modules, which is how the hosted page bundles it into a Cloudflare Worker.

```ts
import { run, renderJson } from 'markdown-parity-check';
import type { Report, SourceInput } from 'markdown-parity-check';

// htmlText and markdownText are the two documents you already fetched or read.
declare const htmlText: string;
declare const markdownText: string;

const base = 'https://example.com/page';
const source = (file: string, body: string): SourceInput => ({
  meta: { kind: 'file', file, bytes: new TextEncoder().encode(body).length, baseUrl: base },
  body,
  base,
});

const report: Report = run(source('page.html', htmlText), source('page.md', markdownText), {
  strict: false,
  mode: 'offline',
});
console.log(report.summary.result, report.summary.exitCode);
console.log(renderJson(report));
```

`run(html, markdown, options)` returns the `Report` object. `renderJson(report)` returns the string that `--format json` prints, with URL query values, fragments and credentials masked. The object `run` returns is not masked. A completed run has the result `pass` with exit code 0 or `fail` with exit code 1. When the comparison cannot finish, for example because the content is empty or a limit is exceeded, `run` throws a `RunError`. `errorReport` builds the error report the command prints in that case.

The options type is `RunOptions`. It takes `selector`, `frontMatter`, `strict`, `mode` and `htmlProfile`, which is `generic` or `starlight`. The Starlight rules are described in [docs/starlight.md](https://github.com/erekola/markdown-parity-check/blob/main/docs/starlight.md). The report records `mode` as `url` or `offline`, and it does not switch any check on or off.

When the Markdown source has `kind: 'url'` in its `meta`, the delivery check runs first and reads the HTTP `status` and `contentType` from that `meta`.

A host with a smaller CPU or memory budget can pass lower `limits`, typed as `RunLimits`: `maxAlignmentPairs`, `maxSimilarityCandidates`, `maxSimilarityWork` and `maxNestingDepth`. The nesting limit also applies to raw HTML blocks inside the Markdown. A limit that is zero, negative or NaN throws a `TypeError` before the comparison starts, and a valid limit that is exceeded is a `RunError`.

Set `maxSimilarityWork` when the library compares untrusted documents. With the default limits one worst case at the full 4 000 000 block pairs (100 HTML blocks of 870 distinct words against 40 000 Markdown blocks of one word each) took tens of seconds in hand timings on development machines. In the same case, a value of 2 000 000 made the pairing step stop, and the whole call, parsing included, took about a second.

The test suite runs the bounded case and asserts no time. When a limit is exceeded, `run` throws a `RunError` whose message names the limit, and the command line reports it with exit code 2.

The library has no time limit and no memory limit of its own. A program that compares untrusted documents needs a time limit and a memory limit of its own, enforced outside the calling thread, for example in a worker thread, in a separate process or in an isolate with a CPU limit. `run` is synchronous, so a timer in the same thread cannot interrupt it, and the command line uses a worker thread for that reason. A link target over 8192 UTF-16 code units is a `RunError`, as described under the limits of the method.

Some costs come from the parsers and are not bounded by this package. The table rule of `micromark-extension-gfm` and the bare link rule of `mdast-util-find-and-replace` take more than linear time, and for a table the cost shows at ordinary sizes. In hand timings of `run` with Node.js 26 on one development machine on 2026-11-22, a two-column table of 8 KiB took about 40 ms, 16 KiB about 110 ms, 32 KiB about 600 ms and 64 KiB, 6 552 rows, about 3 s, so from 16 KiB on each doubling took about five times as long. In earlier hand timings a table of 10 000 one-cell rows and one row of 30 000 cells, under 250 kB, took tens of seconds to parse, and 100 000 bare links in one paragraph, 2.8 MB, took tens of seconds as well. A deeply nested HTML document needs memory in proportion to its blocks times their nesting depth. A document of 650 000 paragraphs inside 1 000 nested elements, 5 MiB, ran out of memory at about 4 GB, which ends a library process. The command line stops the same run with exit code 2, and the test suite does not repeat these timings.

The caller fetches the pages and decides which addresses are allowed. The address policy that the command applies is exported as `assertPublicHost` and `isPublicAddress`. `assertPublicHost` takes `url.hostname` of a parsed `URL`, because the URL parser has already written a literal such as `2130706433` or `0x7f.0.0.1` as dotted decimal by then. A caller that checks the host and the resolved addresses and then lets `fetch()` resolve the name again can be sent to another address by a DNS answer that changes in between. The package exports no helper that pins the checked address. The command connects to the address it checked.

### Report format

The JSON report is the `Report` type. Its top-level fields are:

| Field | Content |
| --- | --- |
| `schemaVersion` | The number `1`. |
| `toolVersion` | The release that produced the report. |
| `generatedAt` | The time the report was made, as an ISO 8601 timestamp in UTC. |
| `mode` | `url` or `offline`. |
| `sources` | The metadata of the HTML and the Markdown input. For a local file, `bytes` is the size of its text without a byte order mark, counted as UTF-8, and not the size of the file on disk. |
| `extraction` | How each side was extracted. It is `null` in an error report and in a result that failed at the delivery check, because no extraction result is reported then. |
| `summary` | `result`, which is `pass`, `fail` or `error`, then `strict`, the counts `errors`, `warnings` and `infos`, `coverage`, which is `null` when nothing was compared, `exitCode` and, when `result` is `error`, `error` and sometimes `errorValue`. |
| `findings` | A list of `Finding` objects, each with `code`, `severity`, `direction` and `message`, and where they apply the `html` and `markdown` locations and the `before` and `after` text. |
| `limitations` | The fixed list of what the check does not cover. |

After the arguments fail validation, the command builds an error report for the argument error from the raw arguments. It takes `mode` from the presence of `--url` and `summary.strict` from the presence of `--strict` in the command line, and it prints the JSON to standard output only when the raw arguments ask for JSON. A command line with neither is recorded as `offline` and not strict, and so is one that gives `--markdown-url` without `--url`.

## Development

The sources are TypeScript under `src/`, compiled with `tsc` to `dist/`. Clone the repository, build it and run the bundled example:

```sh
git clone https://github.com/erekola/markdown-parity-check.git
cd markdown-parity-check
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --html-file test/fixtures/same/page.html --markdown-file test/fixtures/same/page.md --base-url https://example.com/page --front-matter strip
```

The example compares matching content and exits with code 0. It removes the Markdown file's front matter explicitly. Without `--front-matter strip` the same pair fails, because the front matter is compared as content.

`npm run typecheck` runs `tsc --noEmit`. `npm test` builds first and then runs the tests against `dist/`.

## Release process

After CI passes on the main branch, the release workflow `.github/workflows/release.yml` packs the tarball once and publishes it to npm with trusted publishing over OIDC when the version is not there yet. It then downloads the registry copy and checks its integrity hash and its content against the packed file. No npm token is stored.

Only after that check does it create the GitHub release with the verified tarball attached. The release notes are the CHANGELOG.md section of that version, so a version without one stops the release. A version that exists on npm with different content stops the release too. npm packs this README as well, so a change to it reaches the npm page only with a new version.

## Verify a release

GitHub Actions publishes every version from 0.1.2 on with npm trusted publishing, and each one carries a provenance attestation. To check one, install it in an empty directory and ask npm to verify the signatures. Replace the version with the one you want to check.

```sh
mkdir verify-mpc && cd verify-mpc && npm init -y && npm install markdown-parity-check@0.2.43 --ignore-scripts && npm audit signatures
```

`npm audit signatures` checks the registry signature and the provenance attestation of each installed package that has one. The attestation of this package names three things to compare with what you expect: the repository `github.com/erekola/markdown-parity-check`, the workflow file `.github/workflows/release.yml` and the commit that produced the tarball. The npm version page shows them under Provenance.

Tag `v0.2.43` must point at that same commit, and `gh api repos/erekola/markdown-parity-check/commits/v0.2.43 --jq .sha` prints it. A mismatch is a reason not to use that version. Provenance proves which workflow built a release and from which commit. It does not prove that the code is safe, so reading the source and the dependencies stays your job.

## Security

Report vulnerabilities privately to info@turva.dev. See [SECURITY.md](SECURITY.md) for the reporting instructions and the operating limits.

## License

MIT. See [LICENSE](LICENSE).
