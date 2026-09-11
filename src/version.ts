// Tool name and version as literals, so the comparison core has no Node.js import and runs in a
// Cloudflare Worker as well as under Node.js. test/version.test.ts fails the build when these differ
// from package.json, which stays the version the release workflow publishes.

export const TOOL_NAME = 'markdown-parity-check';
export const TOOL_VERSION = '0.2.1';
