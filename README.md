# markdown-parity-check

Compare the main content of HTML and Markdown pages from the command line. The report lists changed text, numbers, links and blocks, each with its source location, from two local files or from both representations of one URL.

## Install

Use Node.js 22 or 24. The package is published on npm as `markdown-parity-check`.

```sh
npx markdown-parity-check --help
```

To install the command permanently, run `npm install -g markdown-parity-check`. The command name is `markdown-parity-check`.

## Usage

To compare a website, run the CLI with `--url https://example.com/page`. It requests HTML and Markdown from the same URL using the corresponding Accept headers. Use `--markdown-url` to specify a separate Markdown address.

```sh
markdown-parity-check --url https://example.com/page
markdown-parity-check --url https://example.com/page --format json --output report.json
markdown-parity-check --html-file page.html --markdown-file page.md --base-url https://example.com/page
```

Front matter in the Markdown file is kept by default. Add `--front-matter strip` to remove it before the comparison.

## Options

| Option | Purpose |
| --- | --- |
| `--url URL` | Request both formats from a URL. |
| `--markdown-url URL` | Set a separate Markdown URL. |
| `--html-file PATH --markdown-file PATH` | Compare local files. |
| `--base-url URL` | Resolve relative links in local files. |
| `--selector CSS` | Choose the HTML content container. |
| `--front-matter keep` or `--front-matter strip` | Keep metadata by default or remove it explicitly. |
| `--format json` | Print a structured report. |
| `--output PATH` | Write the report to a file. |
| `--strict` | Treat warnings as failures. |
| `--timeout-ms MS` | Set the request deadline. |
| `--max-bytes N` | Limit the decoded response size. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Comparison completed without rejecting findings. |
| `1` | Content or Markdown delivery failed the check. |
| `2` | Input or execution prevented a reliable comparison. |

A zero exit code means the implemented checks passed. It does not prove semantic equivalence.

## Scope

The comparison covers headings, paragraphs, lists, tables, code and links. It detects repeated blocks and reports ordering changes. Formatting differences can produce warnings while changed wording produces errors.

HTML content selection prefers the main content container. A fallback to the page body produces a warning. JavaScript is not executed. Block matching is heuristic and some complex layouts need an explicit selector.

URL fetching blocks non-public network targets and checks redirects. Request deadlines and response size limits bound network work. Reports mask URL query values, but content excerpts may still contain private information. Review reports before sharing them.

## Run from source

```sh
git clone https://github.com/erekola/markdown-parity-check.git
cd markdown-parity-check
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --html-file test/fixtures/same/page.html --markdown-file test/fixtures/same/page.md --base-url https://example.com/page --front-matter strip
```

The bundled example compares matching content. It explicitly removes the Markdown file's front matter.

## Development

Run `npm run typecheck` and `npm test`. GitHub Actions tests Node.js 22 and 24 on Windows and Ubuntu. After CI passes on the main branch, the release workflow publishes the package version to npm when it is not there yet and creates the matching GitHub release with the package tarball attached.

## Security

Report vulnerabilities privately to info@turva.dev. See [SECURITY.md](SECURITY.md) for the reporting instructions and the operating limits.

## License

MIT. See [LICENSE](LICENSE).
