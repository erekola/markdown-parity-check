import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { relativeHrefRelation } from '../src/normalize.js';

// relativeHrefRelation makes a claim about every http or https base: 'same' means the two references resolve
// equal under all of them, and 'different' means under none. This checks both claims against real resolution
// with generated references, including the characters the URL parser removes or trims, and with bases that
// reuse the synthetic names the function resolves against. An example test written from the function's own
// reasoning cannot find a gap in that reasoning; this one found none after 0.2.7 and fails on 0.2.6.
describe('relativeHrefRelation against real bases', () => {
  it('never says same or different when some base disagrees', () => {
    let seed = 20260912;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const choose = (list: readonly string[]): string => list[Math.floor(rnd() * list.length)] ?? '';
    const parts = ['.', '..', '/', 'd', 'e', 'f', 'g', 'x', '%2e', '%2E%2e', '\t', '\n', '\r', ' ', '', '\\', '?q', '?r', '#f', ' '] as const;
    const reference = (): string => {
      let s = '';
      const length = Math.floor(rnd() * 7);
      for (let k = 0; k < length; k++) s += choose(parts);
      return s;
    };
    // The second reference is often the first with a character inserted, so that 'same' comes up often.
    const variant = (s: string): string => {
      const at = Math.floor(rnd() * (s.length + 1));
      return s.slice(0, at) + choose(['\t', '\n', '\r', './', '']) + s.slice(at);
    };
    const bases: string[] = [];
    for (const origin of ['https://base.invalid', 'http://other.invalid', 'https://example.com']) {
      for (const path of ['/', '/f', '/d/', '/d/f', '/d/f?q', '/e/g?r', '/d/d/d/d/', '/a/b/c/d/', '/x/d/e/f', '/d/e/d/e/g', '/e/e/e/e/e/e/e/e/']) {
        bases.push(origin + path);
      }
    }
    const resolve = (href: string, base: string): string | null => {
      try {
        return new URL(href, base).href;
      } catch {
        return null;
      }
    };
    const counts = { same: 0, different: 0, uncertain: 0 };
    for (let t = 0; t < 6000; t++) {
      const a = reference();
      const b = rnd() < 0.5 ? variant(a) : reference();
      const ra = bases.map((base) => resolve(a, base));
      const rb = bases.map((base) => resolve(b, base));
      // Only references that resolve under every base say anything about the claim.
      if (ra.includes(null) || rb.includes(null)) continue;
      const relation = relativeHrefRelation(a, b);
      counts[relation]++;
      if (relation === 'uncertain') continue;
      for (let k = 0; k < bases.length; k++) {
        const where = `${JSON.stringify(a)} and ${JSON.stringify(b)} under ${bases[k]}`;
        if (relation === 'same') assert.equal(ra[k], rb[k], where);
        else assert.notEqual(ra[k], rb[k], where);
      }
    }
    assert.ok(counts.same > 500 && counts.different > 500, JSON.stringify(counts));
  });
});
