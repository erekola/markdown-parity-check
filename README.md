# markdown-parity-check

Compare the main content of a page's HTML and Markdown versions. The report lists missing, added and changed blocks, numbers and links, each with its source location. It can request both versions of one URL or read two local files.

## Try it in the browser

The [hosted Markdown parity check](https://turva.dev/markdown-parity-check) runs this comparison on turva.dev. It currently checks the published pages of turva.dev only, and the page states that limit in its opening paragraph and again at the address field. An address on any other site is refused with a message that points to the command-line tool below. Fill in an example puts turva.dev's own tools page in the address field, and Check runs the comparison as a separate step.

## Check your own site

Use Node.js 22 or newer. CI tests Node.js 22 and 24 on Windows and Ubuntu. `npx` runs the published package without a global install:

```sh
npx --yes markdown-parity-check --url https://example.com/page
```

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

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The comparison completed without a rejecting finding. |
| `1` | The comparison completed and found rejecting content or delivery differences. |
| `2` | An input, fetch, parse or report error prevented a reliable comparison. |

Exit code 0 means the implemented checks found nothing to reject. It does not prove that the two versions mean the same thing.

## Options

| Option | Purpose |
| --- | --- |
| `--url URL` | Request both versions from one URL. |
| `--markdown-url URL` | Request the Markdown from a separate address. Needs `--url`. |
| `--html-file PATH --markdown-file PATH` | Compare two local files instead. |
| `--base-url URL` | Resolve relative links in local files. Local-file mode only. |
| `--selector CSS` | Choose the HTML content container. |
| `--front-matter keep` or `--front-matter strip` | Keep Markdown front matter, which is the default, or remove it before the comparison. |
| `--format text` or `--format json` | Print a readable report, which is the default, or a structured one. |
| `--output PATH` | Write the report to a file. An input file is never overwritten. |
| `--strict` | Treat warnings as rejecting findings. |
| `--timeout-ms MS` | Deadline per request. The default is 15 000 ms. |
| `--max-bytes N` | Limit on decoded bytes per response. The default is 5 MiB. |
| `--help`, `--version` | Print the help or the version. |

## What is compared

Without `--selector`, the HTML content comes from `main`, `article` or `[role=main]`. If none of them exists, the page body is used and the report warns that page chrome may leak in. Front matter is kept by default and compared as content. If the HTML does not carry the same text, that alone fails the comparison. The tool also warns when the Markdown starts with a block that looks like YAML front matter, and `--front-matter strip` removes it.

Headings, paragraphs, list items, tables, code blocks and links are compared block by block. Missing and added blocks are errors. So are changes in text, numbers, tables and links. A change of order, heading level, case or punctuation is a warning. Repeated blocks are reported too.

In URL mode the Markdown response is checked first. An HTTP error or an HTML page in place of Markdown fails the check, and nothing is compared.

JavaScript is not executed. Content that a page builds in the browser is compared as the server sent it. Block matching is heuristic, so some layouts need an explicit selector. Reports mask URL query values, but excerpts may still contain private page content. Review a report before you share it.

## Command line and hosted page

Both use the comparison core of this package. They differ in which pages they reach and in their limits:

| Topic | Command-line tool | Hosted page |
| --- | --- | --- |
| Pages | Any public HTTP or HTTPS address, or two local files. | Published turva.dev pages only. |
| Fetching | Network requests from your machine. Non-public addresses are refused, also behind DNS and redirects. | The turva.dev Worker renders both versions itself, so a check sends no request over the network. |
| Response size | 5 MiB per response by default, adjustable with `--max-bytes`. | HTML up to 512 KiB. Markdown up to 128 KiB. |
| Comparison size | Up to 4 000 000 block pairs. | Up to 250 000 block pairs. |
| Rate | Not limited by the tool. | About 10 checks per minute from one IP address at each Cloudflare location. |

The hosted page also answers a JSON POST, described on the page. It runs the release of this package pinned in [turva-worker](https://github.com/erekola/turva-worker), which can be older than the latest npm release. The report's `toolVersion` field shows which release produced it.

A hosted check can fail on turva.dev's own pages as well. On 2026-09-11 the check of https://turva.dev/tools returned `fail` with five errors. The Markdown carries a Related heading and four links that the HTML page does not repeat as a list, and the report listed each of them. The same four targets are links inside that page's tool cards, so the report found a missing structure and not missing content. [HTML and Markdown can disagree](https://turva.dev/blog/html-and-markdown-can-disagree) reads that result in full.

## Library use

The package also exports the comparison without the command-line interface, the file reader or the network code. The library entry imports no Node.js built-in modules, which is how the hosted page bundles it into a Cloudflare Worker.

```js
import { run, renderJson } from 'markdown-parity-check';

// htmlText and markdownText are the two documents you already fetched or read.
const base = 'https://example.com/page';
const source = (file, body) => ({
  meta: { kind: 'file', file, bytes: new TextEncoder().encode(body).length, baseUrl: base },
  body,
  base,
});

const report = run(source('page.html', htmlText), source('page.md', markdownText), { strict: false, mode: 'offline' });
console.log(report.summary.result, report.summary.exitCode);
console.log(renderJson(report));
```

`run(html, markdown, options)` returns the report object that `--format json` prints. A completed run has the result `pass` with exit code 0 or `fail` with exit code 1. When the comparison cannot finish, for example because the content is empty or a limit is exceeded, `run` throws a `RunError`. `errorReport` builds the error report the command prints in that case.

The options are `selector`, `frontMatter`, `strict` and `mode`. The report records `mode` as `url` or `offline`, and it does not switch any check on or off. When the Markdown source has `kind: 'url'` in its `meta`, the delivery check runs first and reads the HTTP `status` and `contentType` from that `meta`. A host with a smaller CPU or memory budget can pass lower `limits`: `maxAlignmentPairs`, `maxSimilarityCandidates`, `maxSimilarityWork` and `maxNestingDepth`. The caller fetches the pages and decides which addresses are allowed. The address policy the command applies is exported as `assertPublicHost` and `isPublicAddress`.

## Run from source

```sh
git clone https://github.com/erekola/markdown-parity-check.git
cd markdown-parity-check
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --html-file test/fixtures/same/page.html --markdown-file test/fixtures/same/page.md --base-url https://example.com/page --front-matter strip
```

The bundled example compares matching content and exits with code 0. It removes the Markdown file's front matter explicitly. Without `--front-matter strip` the same pair fails, because the front matter is compared as content.

## Development

Run `npm run typecheck` and `npm test`. GitHub Actions tests Node.js 22 and 24 on Windows and Ubuntu. After CI passes on the main branch, the release workflow packs the tarball once, publishes it to npm when the version is not there yet, downloads the registry copy and checks its integrity hash and its content against the packed file. Only then does it create the GitHub release with that verified tarball attached. A version that exists on npm with different content stops the release. npm packs this README too, so a change to it reaches the npm page only with a new version.

## Security

Report vulnerabilities privately to info@turva.dev. See [SECURITY.md](SECURITY.md) for the reporting instructions and the operating limits.

## License

MIT. See [LICENSE](LICENSE).
