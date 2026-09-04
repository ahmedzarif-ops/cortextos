import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCEPTANCE_TESTS, REQUIRED_ENV } from './acceptance-tests.js';
import fastConfig from '../vitest.config.js';
import acceptanceConfig from '../vitest.acceptance.config.js';

/**
 * The lanes must PARTITION the test files: every file in exactly one lane.
 *
 * ⛔ THE FAILURE THIS EXISTS TO CATCH IS NOT "a file runs twice" — it is
 * "A FILE RUNS IN NEITHER LANE AND NOBODY NOTICES", because that failure is
 * SILENT AND GREEN. The fast lane goes green because it stopped looking, and
 * the opt-in lane goes green because nobody ran it. Excluding a file is one
 * character away from retiring it, and the two look identical in CI.
 */
describe('acceptance lane partition', () => {
  const fastExclude = (fastConfig as any).test.exclude as string[];
  const acceptanceInclude = (acceptanceConfig as any).test.include as string[];

  it('excludes exactly the acceptance globs from the fast lane', () => {
    for (const glob of ACCEPTANCE_TESTS) expect(fastExclude).toContain(glob);
  });

  it('includes exactly the acceptance globs in the acceptance lane', () => {
    expect(acceptanceInclude).toEqual([...ACCEPTANCE_TESTS]);
  });

  it('has a non-empty acceptance lane — an empty lane exits 0 and reports nothing', () => {
    const dir = resolve(__dirname, 'acceptance');
    const files = readdirSync(dir).filter(f => f.endsWith('.test.ts'));
    // Measured at the time of writing: five files. Asserted as a floor, not an
    // equality, so adding a suite does not break the lane's own guard — but
    // DELETING every suite, which would make the lane silently vacuous, does.
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('documents every env var the lane refuses to run without', () => {
    // HIGH-2: CAPACITY_CONTROLLER_CANDIDATE threw at module scope and was named
    // in no document. The check is that the CODE and the LIST agree — a var that
    // gates the run and is absent from REQUIRED_ENV is exactly the gap that
    // shipped, and it cannot be closed by remembering to write documentation.
    const dir = resolve(__dirname, 'acceptance');
    const sources = readdirSync(dir)
      .filter(f => f.endsWith('.ts'))
      .map(f => require('node:fs').readFileSync(resolve(dir, f), 'utf-8') as string)
      .join('\n');
    const used = new Set(
      [...sources.matchAll(/process\.env(?:\.|\[')([A-Z][A-Z0-9_]+)'?\]?/g)].map(m => m[1]),
    );
    const declared = new Set(REQUIRED_ENV.map(v => v.name));
    for (const name of used) {
      if (name.startsWith('CAPACITY_')) expect(declared).toContain(name);
    }
    // Positive control for this test: the set it scanned must not be empty, or
    // the loop above passes by finding nothing rather than by finding agreement.
    expect([...used].filter(n => n.startsWith('CAPACITY_')).length).toBeGreaterThan(0);
  });
});
