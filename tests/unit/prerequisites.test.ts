/**
 * tests/unit/prerequisites.test.ts
 *
 * ⛔ THE PREREQUISITES `npm test` NEEDS, ASSERTED LOUDLY — because the failure mode of a
 * missing one is NOT a failing suite. It is a QUIETER suite with an unchanged-looking total.
 *
 * Two measured instances, both of which read as a healthy green:
 *   · `dashboard/node_modules` absent -> `next/server` unresolvable: one hard failure and
 *     47 dashboard-adjacent tests self-skip (2649 tests against 2800).
 *   · `dist/cli.js` absent -> the two CLI integration suites self-skip: 7 tests, and the
 *     REPORTED TOTAL DOES NOT MOVE. CI ran that way for its whole history — `2820 passed |
 *     12 skipped (2832)` against `2829 passed | 3 skipped (2832)` with a build. Same total.
 *     The suite did not shrink, it went quiet.
 *
 * ⭐ DELIBERATELY NOT `skipIf`. A silent skip here would reproduce the exact defect under
 * test: an instrument that reports nothing and reads as a pass. (Same stance as
 * `tests/unit/templates/knowledge-digest-coverage.test.ts`, which asserts python3 is
 * present rather than skipping without it.)
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');

describe('prerequisites for `npm test`', () => {
  it('dashboard/ dependencies are installed — 47 tests self-skip without them', () => {
    const nm = join(REPO_ROOT, 'dashboard', 'node_modules');
    expect(
      existsSync(nm),
      `dashboard/node_modules is MISSING. This is not a skippable condition: without it ` +
        `next/server is unresolvable, one test fails hard and 47 more silently self-skip, ` +
        `leaving a large confident total over a smaller suite.\n` +
        `  Run: npm ci --prefix dashboard`,
    ).toBe(true);

    // The DIRECTORY is not the claim — the resolvable module is. An interrupted or partial
    // install leaves the directory behind, and that reads identically to a good one.
    const nextServer = join(nm, 'next', 'server.js');
    expect(
      existsSync(nextServer),
      `dashboard/node_modules exists but next/server is not resolvable at ${nextServer}. ` +
        `A partial install looks exactly like a complete one from the directory alone.\n` +
        `  Run: npm ci --prefix dashboard`,
    ).toBe(true);
  });

  it('dist/ is built — the two CLI integration suites self-skip without it', () => {
    const distCli = join(REPO_ROOT, 'dist', 'cli.js');
    expect(
      existsSync(distCli),
      `dist/cli.js is MISSING. The CLI integration suites are skipIf-gated on this file, so ` +
        `without it they report SKIPPED and the suite total is unchanged — the quietest ` +
        `possible failure.\n` +
        `  Run: npm run build`,
    ).toBe(true);

    // A zero-byte or truncated bundle satisfies existsSync and satisfies nothing else.
    expect(statSync(distCli).size, `dist/cli.js exists but is empty — rebuild it.`).toBeGreaterThan(0);
  });

  /**
   * ⭐ THE CARDINALITY CHECK, and it is the part that survives the next prerequisite.
   *
   * The two assertions above are a list, and a list cannot cover a gate somebody adds next
   * week. This one enumerates every `skipIf(!existsSync(X))` gate in the test tree and
   * requires each gated constant to be one this file already asserts loudly. A new gate
   * fails HERE, at a moment when someone is looking, rather than by quietly removing tests
   * from a run months later.
   *
   * ⛔ WITH A POSITIVE CONTROL, because a scan that matches nothing would otherwise pass and
   * be indistinguishable from a tree with no gates — which is this file's own subject
   * matter. If the pattern ever stops matching, the control fails before the check does.
   */
  it('every existsSync-gated skip in the test tree is covered by a loud control above', () => {
    const CONTROLLED = new Set(['DIST_CLI']);

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.test.ts')) files.push(full);
      }
    };
    walk(join(REPO_ROOT, 'tests'));

    const GATE = /skipIf\(\s*!\s*existsSync\(\s*([A-Za-z_$][\w$]*)\s*\)/g;

    // ⛔ STRIP COMMENTS BEFORE SCANNING, AND THIS FILE PROVED WHY ON ITS FIRST RUN: the
    // scan matched the PROSE IN THIS TEST'S OWN DOCSTRING and reported an uncontrolled
    // gate named `X` in `tests/unit/prerequisites.test.ts`. A checker that reads its own
    // description as evidence is measuring the wrong corpus — the same class as grepping a
    // file's warning text and counting it as an occurrence of the thing warned about.
    // Excluding this one file would have hidden the bug instead of fixing it; every file's
    // prose has the same problem, and only one of them happened to say the magic words.
    const codeOnly = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const found = new Map<string, string[]>();
    for (const f of files) {
      const src = codeOnly(readFileSync(f, 'utf-8'));
      for (const m of src.matchAll(GATE)) {
        const list = found.get(m[1]) ?? [];
        list.push(f.slice(REPO_ROOT.length + 1));
        found.set(m[1], list);
      }
    }

    // POSITIVE CONTROL: the tree is known to contain such gates. A zero here means the
    // pattern stopped matching, not that the gates went away.
    expect(
      found.size,
      'the skipIf-gate scan matched NOTHING. That is an instrument failure, not a clean ' +
        'tree — this repo has existsSync-gated suites. Fix the pattern in this test.',
    ).toBeGreaterThan(0);

    const uncontrolled = [...found.entries()].filter(([name]) => !CONTROLLED.has(name));
    expect(
      uncontrolled.map(([name, where]) => `${name} (${where.join(', ')})`),
      'a test suite is gated on a prerequisite that nothing asserts loudly. Add an ' +
        'assertion for it above and list it in CONTROLLED, or the suite will silently ' +
        'vanish from runs where that prerequisite is absent.',
    ).toEqual([]);
  });
});
