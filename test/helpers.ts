import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');
export const CLI = path.join(ROOT, 'dist', 'src', 'cli.js');

export function fixture(name: string): { html: string; md: string; htmlPath: string; mdPath: string } {
  const htmlPath = path.join(FIXTURES, name, 'page.html');
  const mdPath = path.join(FIXTURES, name, 'page.md');
  return { html: fs.readFileSync(htmlPath, 'utf8'), md: fs.readFileSync(mdPath, 'utf8'), htmlPath, mdPath };
}
