# markdown-parity-check

Compare the main content of HTML and Markdown pages from the command line. The tool reports changed text, numbers, links and blocks with source locations. It can read local files or request both representations of a URL.

## Run from source

Use Node.js 22 or 24 and npm. This package is not published to npm.

```sh
git clone https://github.com/erekola/markdown-parity-check.git
cd markdown-parity-check
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --html-file test/fixtures/same/page.html --markdown-file test/fixtures/same/page.md --base-url https://example.com/page --front-matter strip
node dist/src/cli.js --help
```

The bundled example compares matching content. It explicitly removes the Markdown file's front matter. Front matter is kept by default.

To compare a website, run the CLI with `--url https://example.com/page`. It requests HTML and Markdown from the same URL using the corresponding Accept headers. Use `--markdown-url` to specify a separate Markdown address.

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

## Development

Run `npm run typecheck` and `npm test`. GitHub Actions tests Node.js 22 and 24 on Windows and Ubuntu. The release workflow publishes source archives after CI passes.

## License

The package is marked `UNLICENSED`. No open-source license has been granted.
