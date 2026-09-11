// Library entry point, and the one a Cloudflare Worker bundles: the comparison core without the
// command-line interface, file access or network transport. Nothing reachable from here imports a
// Node.js built-in module; test/core.test.ts walks the import graph and fails the build if one appears.
// Fetching the two documents, and deciding which addresses may be fetched, stays with the caller; the
// address policy the CLI applies is exported so a caller can apply the same one.

export { run, errorReport, deliveryFindings, RunError, LIMITATIONS } from './run.js';
export type { Report, RunOptions, RunLimits, SourceInput, SourceMeta, ExtractionMeta } from './run.js';
export { MAX_NESTING_DEPTH } from './run.js';
export { renderJson, renderText, redactReport } from './report.js';
export { AlignmentLimitError, DEFAULT_LIMITS, MAX_ALIGNMENT_PAIRS, MAX_SIMILARITY_CANDIDATES, checkAlignmentLimit } from './align.js';
export type { AlignmentLimits } from './align.js';
export type { Coverage } from './compare.js';
export type { Finding, FindingSide, Severity, Direction } from './model.js';
export { maskUrl, maskHref, redactText } from './normalize.js';
export { ipVersion, isPublicAddress, isPublicIPv4, isPublicIPv6, assertPublicHost, assertPublicResolved, BlockedAddressError } from './netguard.js';
export { TOOL_NAME, TOOL_VERSION } from './version.js';
