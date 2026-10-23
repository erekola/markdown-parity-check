# markdown-parity-check changelog

Each section is the change list of one release. The release workflow uses the section of the released version as the GitHub release notes and stops the release when that section is missing.

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
