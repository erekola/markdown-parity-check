# Security policy

## Supported versions

Security fixes target the latest published release. Update to that release when a fix is available.

## Reporting a vulnerability

Report suspected vulnerabilities privately to info@turva.dev. Include the affected version, reproduction steps and the expected impact. Remove credentials and private content from examples.

Please do not open a public issue for security reports. You can expect an initial response within a few days. Confirmed issues will be prioritized and you will be kept informed of progress.

## Network and file access

URL mode requests HTML and Markdown over HTTP or HTTPS. Non-public network targets are blocked, including targets reached through DNS and redirects. Each fetch has a deadline and a limit on decoded response bytes. The defaults are 15 seconds and 5 MiB. JavaScript from fetched pages is not executed.

Offline mode reads the two files supplied by the caller. The output option writes a report to the selected path. Reports mask URL query values, but excerpts may contain private page content. Review reports before sharing them.

## Dependencies and releases

The tool uses runtime dependencies to parse and compare content. Dependency versions and integrity hashes are recorded in package-lock.json. GitHub Actions installs locked dependencies with install scripts disabled and runs type checks and tests on Windows and Ubuntu.

The package is published on npm as `markdown-parity-check`. Each version has a matching GitHub release with the tarball attached. The first npm release was published from a maintainer machine and has no provenance attestation. Later versions may be published from GitHub Actions with trusted publishing. Check the version page on npmjs.com before relying on provenance for a given version.
