# markdown-parity-check changelog

Each section is the change list of one release. The release workflow uses the section of the released version as the GitHub release notes and stops the release when that section is missing.

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
