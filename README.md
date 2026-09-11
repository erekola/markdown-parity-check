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

URL fetching blocks non-public network targets and checks redirects. Request deadlines and response size limits bound network work. The comparison itself is bounded too: the product of the HTML and Markdown block counts may not exceed 4 000 000, which is 2 000 blocks on each side. Above that the tool exits with code 2 and an error instead of allocating memory without limit. HTML or Markdown nested deeper than 1 024 levels also ends with code 2, before the extraction can exhaust the call stack. Reports mask URL query values, but content excerpts may still contain private information. Review reports before sharing them.

## Library use

The package has a library entry as well. It runs the same comparison as the command, without the command-line interface, the file reader or the network code. It uses no Node.js built-in modules, so it can also be bundled for Cloudflare Workers.

```js
import { run, renderJson } from 'markdown-parity-check';

const report = run(htmlSource, markdownSource, { strict: false, mode: 'url' });
console.log(renderJson(report));
```

Each source is an object with the document text, a base URL for links and the source details the report shows. The report is the same object that `--format json` prints. A host with a smaller CPU or memory budget can pass lower limits in the `limits` option, and a run that exceeds one ends with an error. Fetching the pages and deciding which addresses may be fetched stays with the caller. The address policy the command applies is exported as `assertPublicHost` and `isPublicAddress`.

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

Run `npm run typecheck` and `npm test`. GitHub Actions tests Node.js 22 and 24 on Windows and Ubuntu. After CI passes on the main branch, the release workflow packs the tarball once, publishes it to npm when the version is not there yet, downloads the registry copy and checks its integrity hash and its content against the packed file. Only then does it create the GitHub release with that verified tarball attached. A version that exists on npm with different content stops the release.

## Security

Report vulnerabilities privately to info@turva.dev. See [SECURITY.md](SECURITY.md) for the reporting instructions and the operating limits.

## License

MIT. See [LICENSE](LICENSE).
