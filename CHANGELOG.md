# markdown-parity-check changelog

Each section is the change list of one release. The release workflow uses the section of the released version as the GitHub release notes and stops the release when that section is missing.

## 0.2.34 (2026-11-05)

This release changes which page pairs pass, in both directions. Raw HTML in Markdown is read closer to the way the HTML side is read, and a changed symbol or combining mark is no longer treated as punctuation. The changes come from an outside read of this repository, repeated against the current code before each fix.

Raw HTML in Markdown:

- Open raw elements stay on one full stack. A `nav`, `form`, `role=navigation`, hidden or `aria-hidden` wrapper hides the Markdown blocks inside it, and the end tag of an ancestor closes a hidden descendant left open. A left-out wrapper that is never closed hides every block after it, the way it does in HTML, and a document left with no content ends with exit code 2.
- A visible `<a href>` around Markdown blocks gives them its link, the way a block anchor reads on the HTML side. Over an HTML paragraph that has no link, such a raw anchor reports `LINK_ADDED`.
- An excluded raw block such as `<nav>Copy</nav>` no longer raises `MARKDOWN_RAW_HTML_SKIPPED`. The warning stays for text that really goes unread.
- A quoted `>` in an inline tag attribute no longer breaks the tag, so a link keeps its target and a hidden span stays hidden.
- Raw HTML in a list item keeps the item's number and nesting level when it is what the HTML side reads as the item: inline content, a paragraph with text, a heading, a code block or a table without a caption. A raw `div`, `blockquote`, `section` or `details` as the whole item stays a plain block, as on the HTML side. A raw paragraph with no text or a raw table with a caption can still report `STRUCTURE_CHANGED`, which is a warning.
- A Markdown document with more than 1,024 raw elements open at once now stops with exit code 2, the limit that the HTML side already had. Void elements such as `<br>` and elements that close implicitly such as `<p>` and `<li>` do not fill it.

Lists, selectors and locations:

- A list item that starts with a heading, code or a table now compares its number, kind and nesting.
- `--html-profile starlight --selector starlight-tabs` reads the tabs the same way as the page walk.
- A task checkbox with an excluded role of its own is ignored.
- A line that ends in a lone CR counts as one line in reported locations.

Comparison:

- A changed combining mark or symbol is `TEXT_CHANGED`, such as `✅` against `❌` or `≤` against `≥`, also when a reader sees the same meaning, such as a dropped trademark sign. A difference of punctuation or case stays `TEXT_MINOR_CHANGED`, and so does a variation selector.
- Number tokens read every decimal digit in Unicode, so a reversed sign on Arabic-Indic or full-width digits is `NUMBER_CHANGED`.
- Repeated text blocks use the link target to break a tie in pairing, so a removed block is reported as removed. Pairing by text alone stays when the targets do not differ.
- Links with the same name pair in order when one occurrence gains or loses its link. Two swapped targets and an added link report as two target changes and one addition.
- Only U+0000 to U+0020 are trimmed from a link target. A no-break or ideographic space in a target is a difference.

Fetching and the command line:

- The HTML decoder follows the order of the HTML standard: byte order mark, Content-Type header, meta declaration in the first 1,024 bytes, then UTF-8. Markdown decoding is unchanged.
- The check for HTML served as Markdown skips leading comments, processing instructions and declarations. Real Markdown that starts with a comment is unaffected.
- A bracketed IPv6 literal goes to no DNS lookup, and the address policy runs on it before the connection.
- A closed stdout pipe ends with exit code 2 instead of an uncaught exception.

Tests and documentation:

- The test for the import graph now follows runtime dependencies and has a negative control with a planted `node:fs` import.
- New tests cover image parity for inline and reference images. Mutating the image reading now fails them.
- The README says that a moved block with changed words or numbers receives no order finding, because the two blocks cannot be matched as the same block.

## 0.2.33 (2026-11-05)

This release does not change which page pairs pass. It fixes a timeout that left a socket open after a redirect, builds the User-Agent from the tool version, makes the release check refuse a package that holds a sync conflict copy, and corrects what the documentation says about the time a comparison can take.

- Timeout after a redirect: the close event of one redirect hop no longer clears the deadline's active request when the next hop is already running. Before, a server that redirected and then stalled made the fetch fail with a timeout after the deadline but left the second request and its socket open. The regression test in `test/fetch.test.ts` fails on 0.2.32.
- User-Agent: the request header reads `markdown-parity-check/<version> (+local content comparison)` with the running version. It was a fixed `0.1`.
- Release check: `tools/release-check.ts` fails, before any registry request, when the packed tarball holds a file whose name has the form of a sync conflict copy, such as `cli (# Edit conflict ... #).js`.
- SECURITY.md and README: the time of the block pairing grows with the distinct words of each HTML block as well as with the number of block pairs, and `maxSimilarityWork` is unbounded by default. Both documents give one measured case and say that a library caller that compares untrusted documents should set the limit.

## 0.2.32 (2026-11-04)

The tool compares exactly as it did before, and a report now names version 0.2.32. This release adds Node.js 26 to the CI matrix.

- CI: `.github/workflows/ci.yml` runs Node.js 22, 24 and 26 on Windows and Ubuntu.
- Release notes: the provenance sentence that `.github/workflows/release.yml` writes names the same three versions.
- README: the line about the test matrix names Node.js 26.

## 0.2.31 (2026-11-04)

This release does not change which page pairs pass. It makes the check for a parenthesized user-information shape take near linear time on a Markdown file with many bare autolinks, and it corrects the wording of one warning, one note and one source comment.

- Fixed, time: `insideParenUserinfo` ran its regular expression on the whole text, and a search that finds nothing goes on to the end of the text, so every bare autolink of a Markdown file rescanned the rest of the file and the time grew with the square of the size. It now searches a prefix of the text that ends a fixed span after the 4 096-character window, with the same indices, so the answers are the same. Measured on a file of bare autolinks with one `insideHiddenUrlPart` call per link, which calls `insideParenUserinfo` each time, medians of three runs for 8, 16, 32, 64, 128 and 256 KB: 11, 34, 113, 400, 1 509 and 5 910 ms in 0.2.30, and 11, 33, 79, 169, 356 and 744 ms now. The growth per doubling of the size was 3.1 to 3.9 and is now 2.1 from 64 KB on.
- Changed, report text only: the warning `EXTRACTION_LOW_CONFIDENCE` said that the body was used "because no <main>, <article> or [role=main] element exists", and the extraction note said the same, also when such an element exists but is hidden or sits in left-out content. Both now say that no eligible visible main-content element was found. The code, the severity and the fallback to `<body>` are unchanged. A program that compares the old message text must be updated.
- Comment: the comment in `src/normalize.ts` said that `JSON.stringify` escapes every control character. It escapes only the C0 controls and lone surrogates, and leaves U+007F, the C1 controls and the bidi controls literal. The comment now says so and names `redactText`, which strips those characters from every string before the JSON is written. No code changed.
- Measured on the 86 pages of turva.dev's sitemap as stored HTML and Markdown pairs, on the 9 fixture pairs and on 167 synthetic Markdown files with many bare autolinks and `scheme://(name):secret@host` shapes: 0.2.30 and 0.2.31 gave the same exit code and the same findings, in both the JSON and the text report, on every pair, apart from the tool version, the timestamp and the two sentences above.
- Tests: `test/linear.test.ts` gains five cases. One compares the cost of a call on a 64 KB and a 4 MB text, one times a file of 16 000 bare autolinks, and three compare `insideParenUserinfo` with a copy of the 0.2.30 function on hand-picked edges at the window cuts and on 1 500 generated texts. The two timing cases fail on 0.2.30. `test/compare.test.ts` gains one case for the new wording of the warning and the note.

## 0.2.30 (2026-11-02)

This release changes which page pairs pass, in both directions. A link whose children hold a block element, such as a linked card (`<a href="..."><h2>Title</h2><p>Body</p></a>`), was read as one run of inline text, so the card's heading stopped being a heading. It is now read as the blocks it contains, and each block carries the link with that block's own text as the link text.

- Fixed, a pair that failed now passes: a card whose HTML heading and paragraph sit inside a link, against Markdown that writes `## [Title](url)` and `[Body](url)`. Same content, same heading level and same target, yet the run ended with four errors. Found on real sites in 60 reviewed reports over 7 pages.
- Fixed, a pair that passed now fails: a card whose HTML heading sits inside a link, against Markdown that writes the title as a plain linked paragraph. The HTML heading was lost, and the run ended with exit code 0 and no findings, also under `--strict`. It now reports the missing heading and the added paragraph.
- A change inside a card is reported as that change: a changed body text, a changed link target and a changed heading level each give their own finding, where the 0.2.29 report for any card was four errors whatever had changed.
- Unchanged: a link with inline content only, a link without `href`, and a link whose block children are all hidden are read as before. A table cell still reads a card link as the cell's text. A list item whose link holds one plain paragraph stays a list item. Any other block link inside a list item is a block child of the item, like a `div` there: its heading and paragraphs are separate blocks, and the item itself is not a list item block.
- Measured on the 86 pages of turva.dev's sitemap, each fetched in URL mode as HTML and as its Markdown twin: 0.2.29 and 0.2.30 gave the same exit code and the same findings on every page. In both versions 84 pages pass, one fails and one could not be fetched.
- Docs: the README says that the command-line tool connects directly to the validated address and does not use `HTTP_PROXY` or `HTTPS_PROXY`, so behind a mandatory proxy the file mode is the way. That is by design: the address is pinned after validation. The README also describes how a linked card is compared.
- Tests: `test/review-0230.test.ts` has 17 cases, 10 of which fail on 0.2.29.

## 0.2.29 (2026-10-23)

A run that finishes within its deadline compares as before, and its report differs only in the redacted text noted below. This release bounds the time of parsing and comparison in the command line and closes several smaller gaps found in an outside review.

- Fixed: `maskHref` no longer takes quadratic time on a URL with many query keys. 20,000 keys now mask in under 50 ms where they took more than 25 seconds. The output is byte-identical.
- Fixed: when a fetch is refused for exceeding `--max-bytes`, or reaches the whole-fetch deadline, the decompression stream and the response are now destroyed with the request, so a gzip, deflate or brotli bomb is no longer decoded to its full size in the background. Before the fix a 64 MiB gzip or deflate bomb and a 256 MiB brotli bomb each decoded in full. After it decoding stops when the fetch is refused, near the `--max-bytes` cap or at the deadline.
- Changed: `--timeout-ms` now also bounds parsing and comparison, in URL mode and in file mode. The step runs in a worker thread that is stopped at the deadline, and the run ends with exit code 2 and an error message. The deadline starts once the worker has loaded, so its start-up does not count. A 64 KiB Markdown file of unmatched emphasis delimiters took more than 10 seconds to parse and now stops at the deadline. The worker adds about 0.2 seconds to a run. The library entry point is unchanged and has no deadline.
- Changed: `redactText`, which the library entry point also exports, now also removes the C1 control characters U+0080 to U+009F and the Unicode bidi controls U+202A to U+202E and U+2066 to U+2069 from report text, as the hosted validator already did. Library users see changed text in reports. The comparison itself is unchanged.
- Fixed: the address policy now checks the IPv4 address inside the IPv4-translated range `::ffff:0:a.b.c.d`, for example `::ffff:0:7f00:1` and `::ffff:0:a00:1`, as it does for the mapped form `::ffff:a.b.c.d`. These were treated as public before.
- Fixed: the release check in `tools/release-check.ts` reports a malformed registry reply, such as a null body or a field of the wrong type, as a clear error instead of a TypeError.
- Fixed: the release workflow now stops before publishing when the default branch has moved past the tested commit, so the provenance attestation names the commit the workflow built, and two release runs no longer overlap. A workflow_run always runs the default branch's copy of the workflow, so this protects the push after the one that carries it.
- Docs: source comments name `src/worker.ts` in turva-worker instead of the retired `worker.js`. README, SECURITY.md and the `--help` text describe the wider deadline.
- Tests: a new test checks every version the README names in its release check and its install line against `package.json`.

## 0.2.28 (2026-10-21)

The tool compares and reports exactly what it did before. This release rewrites the README.

- The library section has a TypeScript example and a table of the JSON report fields.
- New sections cover the release process and local development, and the sample output comes from this release.
- The Starlight profile link points to docs/starlight.md on GitHub, because docs/ is not in the npm package.

## 0.2.27 (2026-10-17)

The tool compares and reports exactly what it did before. This release updates one pinned workflow action.

- actions/setup-node 7.0.0 to 7.1.0 in the CI and release workflows, pinned by commit SHA.

## 0.2.26 (2026-10-09)

The tool compares and reports exactly what it did before. This release updates two locked dependencies.

- mdast-util-from-markdown 2.0.3 to 2.1.0, a runtime dependency, lockfile only.
- @types/node 22.20.4 to 22.20.5, a development dependency, lockfile only.

## 0.2.25 (2026-10-03)

The tool compares and reports exactly what it did before. This release changes one test only.

- A test of left-out subtrees built its HTML with a string replace that CodeQL reported as incomplete escaping. It now joins the opening and closing tags directly and covers the same four wrappers.

## 0.2.24 (2026-10-03)

The tool compares and reports exactly what it did before. This release changes documentation only.

- SECURITY.md names an encrypted route for reports: erik@turva.dev with the OpenPGP key at https://turva.dev/pgp-key.asc.

## 0.2.23 (2026-10-02)

No change to what the tool compares or reports. Documentation and release notes only.

- The README and SECURITY.md have a new section, Verify a release. It shows how to install a version in an empty directory, run `npm audit signatures`, compare the repository, the workflow and the commit in the provenance attestation with the release tag, and it says that provenance records where a release was built and does not show that the code is safe.
- SECURITY.md now states that every version from 0.1.2 on is published from GitHub Actions with npm trusted publishing and carries a provenance attestation. It said before that later versions might be.
- This changelog is new. The GitHub release notes of each version are now its section here, followed by the build and provenance text. Before, every release carried the same fixed text.

## 0.2.22 (2026-10-02)

Changes from an outside review of this package on 2026-10-02. Several of them change which pages pass or stop, so a page that passed on 0.2.21 can now report a difference, and the other way round.

- A rejected `--format` or `--front-matter` value is shown with its credentials masked. A URL with a user name or password passed there was echoed in full before.
- An automatic content root, which is `main`, `article` or an element with `role="main"`, is no longer chosen when it is a left-out part of the page or sits inside one, such as `nav`, a dialog, a banner or a navigation role. The body is used instead and the usual low-confidence warning follows. A `main` inside an ordinary full-page `form` is still kept, because ASP.NET WebForms pages wrap the whole page in one.
- A task checkbox counts as part of a list item only when no left-out part of the page lies between the checkbox and the item.
- A visible `br` inside a code block counts as a line break, in the generic reader and in the Starlight reader.
- A code block is reported as changed in whitespace only when collapsing whitespace makes both sides equal. Whitespace here means ASCII whitespace and the Unicode space separators, so a no-break space against a plain space is a whitespace change. A changed soft hyphen, zero width space or composed letter against its decomposed form is `TEXT_CHANGED`, an error, and is no longer reported as `CODE_WHITESPACE_CHANGED`.
- Inline raw HTML tags that the HTML side leaves out, such as `button`, `script`, `nav`, `form`, `svg`, `template` and a left-out role, are skipped through their closing tag in Markdown. An unclosed one is reported as `MARKDOWN_INLINE_HTML_UNSUPPORTED` and compared as visible. A self-closing `svg` or `math` counts as a closed empty element and is skipped with no warning. Any other left-out tag written as self-closing is not closed in HTML, so it takes the normal path and warns when no closing tag follows.
- A hidden or `aria-hidden` raw HTML wrapper that is opened in one Markdown block now hides the blocks after it until it is closed. The raw HTML fallback warning ignores hidden text.
- Links whose label is only punctuation are now paired by their unchanged target.
- A table of about 130 000 rows no longer ends in an unwrapped `RangeError`.
- A block that moved and was also edited is reported as `ORDER_CHANGED`. The flag goes to the edited block and never to a block that matches exactly.
- A rejected option value that holds an at sign and parses with no host is shown with everything before its last at sign replaced by three asterisks. Values that parse with a host keep the masked URL form.
- SECURITY.md now says that the bounded work is block pairs, that the pairing of links inside one block has no separate limit by default, and that an initial response comes within one business day. The code's limits did not change.
