import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string; name: string };

export const TOOL_NAME = pkg.name;
export const TOOL_VERSION = pkg.version;
