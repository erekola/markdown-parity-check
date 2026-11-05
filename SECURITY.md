# Security policy

## Supported versions

Security fixes target the latest published release. Update to that release when a fix is available.

## Reporting a vulnerability

Report suspected vulnerabilities privately to info@turva.dev. Include the affected version, reproduction steps and the expected impact. Remove credentials and private content from examples. Send encrypted reports to erik@turva.dev. The OpenPGP key is at https://turva.dev/pgp-key.asc.

Please do not open a public issue for security reports. You can expect an initial response within one business day. Confirmed issues will be prioritized and you will be kept informed of progress.

## Network and file access

URL mode requests HTML and Markdown over HTTP or HTTPS. Non-public network targets are blocked, including targets reached through DNS and redirects. Each fetch has a deadline and a limit on decoded response bytes. The defaults are 15 seconds and 5 MiB. In the command line the same deadline also covers parsing and comparison, which run in a worker thread that is stopped when the deadline passes, and the tool then exits with code 2. The library entry point has no such deadline, so a program that compares untrusted documents with it needs a time limit of its own. JavaScript from fetched pages is not executed.

The number of block pairs is bounded by the product of the two block counts, at most 4 000 000. The time spent on each pair is not: the similarity search walks the distinct words of the HTML block once per pair, so the work grows with block pairs times distinct words per HTML block. One measured case, 100 HTML blocks of 870 distinct words each against 40 000 Markdown blocks of one word each, which is 4 000 000 pairs, took between 26 and 30 seconds with default limits on development machines, in two measurements by two people. The command line stops such a run at its deadline. The number of similar block pairs kept for matching is bounded as well. Above either limit the tool stops with exit code 2 and an error message instead of reporting a pass for a comparison it did not complete. The pairing of links inside one block is not separately bounded by default: with the default limits it has no budget of its own, and a block with thousands of links that cannot be resolved against a base URL can take time that grows with the square of the link count. The maxSimilarityWork limit is unbounded by default and covers both cases, so a library caller that compares untrusted documents should set it. In the case above, a limit of 2 000 000 made the pairing step stop after about 70 milliseconds, on top of the time spent parsing the two documents, and the whole call took under one second. The comparison functions `align` and `compare` throw an `AlignmentLimitError` there, while `run` turns it into a `RunError` with the same message, which the command line reports with exit code 2.

Offline mode reads the two files supplied by the caller. The output option writes a report to the selected path. Reports mask URL query values and fragments and remove any user name or password from a URL. Excerpts may contain private page content. Review reports before sharing them.

## Dependencies and releases

The tool uses runtime dependencies to parse and compare content. Dependency versions and integrity hashes are recorded in package-lock.json. GitHub Actions installs locked dependencies with install scripts disabled and runs type checks and tests on Windows and Ubuntu.

The package is published on npm as `markdown-parity-check`. Each version has a matching GitHub release. The attached tarball is the registry copy after its integrity hash and content were checked against the freshly packed file. The first npm release was published from a maintainer machine and has no provenance attestation. Its npm metadata names commit 7e8fad9 as its source, while the tag of that release points at 3f3a599, the release commit that follows it and adds the license, this policy, the release workflow and the package manifest without changing src/ or test/. The tag stays where it is. Every version from 0.1.2 on is published from GitHub Actions with npm trusted publishing and carries a provenance attestation, which the registry served for each of them when it was last checked on 2026-10-02.

## Verify a release

To check a release, install it in an empty directory with `npm install markdown-parity-check@<version> --ignore-scripts` and run `npm audit signatures`. The provenance attestation must name the repository `github.com/erekola/markdown-parity-check`, the workflow file `.github/workflows/release.yml` and a commit that the release tag `v<version>` also points at. `gh api repos/erekola/markdown-parity-check/commits/v<version> --jq .sha` prints the tag's commit. The npm version page shows the attestation's commit under Provenance. Provenance names the repository, the workflow and the commit that produced a release. It does not prove that the code is safe.
