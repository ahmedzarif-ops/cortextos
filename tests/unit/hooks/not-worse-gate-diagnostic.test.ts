import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * THE DIAGNOSTIC MUST AGREE WITH THE PREDICATE IT EXPLAINS.
 *
 * ⛔ THE DEFECT THIS PINS. `#46` fixed the gate's PREDICATE to count ANY test-path change after
 * guard measured a MODIFY-only diff hitting the strict arm and refusing a valid push. It left the
 * DIAGNOSTIC filtering `^[AD]`. On a modify-only diff the gate therefore printed:
 *
 *     ⚠ FINDING: collected totals differ (X vs Y) and the diff touches 1 test path(s):
 *     <nothing>
 *
 * A finding with a colon and an empty list — which reads as THE PREDICATE being wrong when the
 * PRINTER is wrong. Measured on real shas before this was written: predicate 1, printed rows 0.
 * ⭐ Same shape as the bug it was created by: the fix corrected a check and not the sentence that
 * explains the check.
 *
 * ⛔ WHY THESE ARMS DO NOT USE `not-worse-gate.test.ts`'s FIXTURE. That file's `beforeAll` runs a
 * real `npm install`, in the FAST lane, whose hook timeout is 10000ms (measured, not quoted). These
 * arms need no packages, so binding them to a network install would make a source-shape property
 * fail on npm cache warmth. The network-install finding is tracked separately and deliberately NOT
 * patched over here.
 *
 * ⚠ THE MARKER BELOW IS A THIRD COPY OF AN INTERFACE (gate, not-worse-gate.test.ts, here). That is
 * inherent — a shell script cannot export it — so every copy asserts it was FOUND rather than
 * assuming it, and a miss fails on a named locator instead of on eight unrelated assertions.
 */
const FUNCTIONS_END_MARKER = '# ---- functions end ----';
const GATE = join(process.cwd(), 'scripts', 'hooks', 'lib', 'not-worse-gate.sh');

let repo: string;
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(args: string[]) {
  execFileSync('git', args, {
    cwd: repo,
    env: {
      ...ENV,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'f@x',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'f@x',
    },
  });
}

/**
 * Source the gate's functions and run one command against the fixture repo.
 *
 * ⛔ `ok` EXISTS BECAUSE `grep -c .` EXITS 1 ON A COUNT OF ZERO, and the first version of this
 * helper demanded status 0 — so the ONE arm asserting a legitimate zero failed on the HELPER, with
 * a message about exit codes, while the count it produced was correct. A harness that treats a
 * valid zero as an error is the same fail-shape the gate itself exists to prevent, one level down.
 * ✅ CHECKED, AND IT DOES NOT REACH THE GATE: `not-worse-gate.sh` is `set -uo pipefail` with NO
 * `-e` (measured: `X="$(printf '' | grep -c .)"` leaves X=0 and execution continues), and
 * `pre-push`, which IS `set -euo pipefail`, `exec`s the gate rather than sourcing it, so its `-e`
 * does not govern the gate's body. Reported as a checked negative rather than left unstated.
 */
function inGate(script: string, ok: number[] = [0]): string {
  const src = readFileSync(GATE, 'utf-8');
  const cut = src.indexOf(FUNCTIONS_END_MARKER);
  expect(
    cut,
    `cannot find ${FUNCTIONS_END_MARKER} in the gate — that marker is an interface between these ` +
      'two files and something moved it',
  ).toBeGreaterThan(0);
  const r = spawnSync('bash', ['-c', `${src.slice(0, cut)}\n${script}`], {
    cwd: repo,
    env: ENV,
    encoding: 'utf-8',
  });
  expect(ok, `bash exited ${r.status}: ${r.stderr}`).toContain(r.status);
  return r.stdout;
}

/** What the gate counts (`grep -c .`) and what it prints, from the SAME call it really makes. */
function counts(base: string, head: string) {
  const predicate = Number(inGate(`changed_test_paths ${base} ${head} | grep -c .`, [0, 1]).trim());
  // [0, 1] on BOTH calls: `grep`'s no-match exit is 1, the gate is `pipefail`, and a
  // legitimate empty result must not read as a broken command. Anything else (2, 127) still
  // fails, so a real bash error is still loud.
  const printed = inGate(`changed_test_paths ${base} ${head} | sed 's/^/    /'`, [0, 1])
    .split('\n')
    .filter((l) => l.trim() !== '');
  return { predicate, printed };
}

let BASE = '';
const HEADS: Record<string, string> = {};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gate-diagnostic-'));
  git(['init', '-q', '-b', 'main']);
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'tests', 'kept.test.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'tests', 'removed.test.ts'), 'export const b = 1;\n');
  writeFileSync(join(repo, 'tests', 'renamed.test.ts'), 'export const c = 1;\n');
  writeFileSync(join(repo, 'src.ts'), 'export const s = 1;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  BASE = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: ENV, encoding: 'utf-8' }).trim();

  const commit = (name: string, mutate: () => void) => {
    mutate();
    git(['add', '-A']);
    git(['commit', '-qm', name]);
    HEADS[name] = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: ENV, encoding: 'utf-8' }).trim();
    git(['checkout', '-q', BASE]);
    git(['checkout', '-q', '-B', 'main', BASE]);
  };

  commit('modify-only', () => writeFileSync(join(repo, 'tests', 'kept.test.ts'), 'export const a = 2;\n'));
  commit('add-only', () => writeFileSync(join(repo, 'tests', 'added.test.ts'), 'export const d = 1;\n'));
  commit('delete-only', () => rmSync(join(repo, 'tests', 'removed.test.ts')));
  commit('rename-only', () => {
    rmSync(join(repo, 'tests', 'renamed.test.ts'));
    writeFileSync(join(repo, 'tests', 'renamed-to.test.ts'), 'export const c = 1;\n');
  });
  commit('non-test-only', () => writeFileSync(join(repo, 'src.ts'), 'export const s = 2;\n'));
  commit('mixed', () => {
    writeFileSync(join(repo, 'tests', 'kept.test.ts'), 'export const a = 3;\n');
    writeFileSync(join(repo, 'tests', 'added2.test.ts'), 'export const e = 1;\n');
    rmSync(join(repo, 'tests', 'removed.test.ts'));
  });
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('not-worse gate: the FINDING lists every path the predicate counted', () => {
  /**
   * ⛔ EACH ARM ASSERTS BOTH HALVES. "printed === predicate" alone passes vacuously at 0 === 0 —
   * a control that can only pass. The expected non-zero count is asserted beside it, so a
   * pathspec that stopped matching anything would fail here instead of agreeing with itself.
   */
  const cases: Array<[string, number, string]> = [
    ['modify-only', 1, 'M'],
    ['add-only', 1, 'A'],
    ['delete-only', 1, 'D'],
    ['rename-only', 1, ''],
    ['mixed', 3, ''],
  ];

  for (const [name, expected, status] of cases) {
    it(`${name}: predicate and printed rows agree, and both are ${expected}`, () => {
      const { predicate, printed } = counts(BASE, HEADS[name]);
      expect.soft(predicate, `${name} predicate`).toBe(expected);
      expect.soft(printed.length, `${name} printed rows`).toBe(expected);
      expect.soft(printed.length, `${name} agreement`).toBe(predicate);
      if (status !== '') {
        expect.soft(printed.join('\n'), `${name} status letter`).toContain(status);
      }
    });
  }

  it('modify-only is the REGRESSION case: it printed nothing while the predicate said 1', () => {
    const { predicate, printed } = counts(BASE, HEADS['modify-only']);
    expect(predicate).toBe(1);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('kept.test.ts');
    expect(printed[0].trimStart().startsWith('M')).toBe(true);
  });

  /**
   * ⛔ THE LIMIT OF THE ARMS ABOVE, CLOSED HERE RATHER THAN LEFT UNSTATED. They call
   * `changed_test_paths` and re-issue the call site's pipeline BY HAND, so they prove the shared
   * function is right and would NOT notice a filter re-added at the call site itself — I proved
   * that by measuring it: reproducing the historical defect required editing this file as well as
   * the gate. A control that has to be edited to see a regression is not watching that regression.
   * ⇒ So this arm reads the SOURCE of the FINDING block and asserts the print goes through the
   * shared function with nothing narrowing it.
   */
  it('the FINDING block prints through the shared function, unfiltered', () => {
    // ⛔ LOCATE BY LINE SHAPE, NOT BY THE PROSE. The first version of this arm used
    // `indexOf('⚠ FINDING: collected totals differ')` — and matched THE COMMENT ABOVE THE FUNCTION,
    // which quotes that exact sentence while explaining the defect. It read documentation OF the
    // code as the code. Rule 217b, committed inside the arm written to close a locator weakness,
    // and caught in one look only because the failure named the right cause ("does not print
    // through changed_test_paths") instead of an assertion about counts.
    // ⇒ A CODE LINE HAS A SHAPE A COMMENT DOES NOT: it starts with `say "`, not with `#`.
    const lines = readFileSync(GATE, 'utf-8').split('\n');
    const sayIdx = lines.findIndex((l) => /^\s*say "⚠ FINDING: collected totals differ/.test(l));
    expect(sayIdx, 'cannot find the FINDING say-line in the gate (code, not comment)').toBeGreaterThan(0);
    const endIdx = lines.findIndex((l, i) => i > sayIdx && /^\s*fi\s*$/.test(l));
    expect(endIdx, 'the FINDING block has no closing fi').toBeGreaterThan(sayIdx);
    const src = lines.join('\n');
    const printLine = lines
      .slice(sayIdx + 1, endIdx)
      .find((l) => l.includes('changed_test_paths') && l.includes('sed'));
    expect(printLine, 'the FINDING block does not print through changed_test_paths').toBeDefined();
    // Any status-restricting grep between the function and the printer re-opens the defect.
    expect(printLine).not.toMatch(/grep\s+-E\s+'\^\[/);
    // ...and the predicate must read the same function.
    expect(src).toMatch(/TEST_FILE_DELTA="\$\(changed_test_paths /);
  });

  it('a non-test change is counted by neither — the pathspec still filters', () => {
    const { predicate, printed } = counts(BASE, HEADS['non-test-only']);
    expect(predicate).toBe(0);
    expect(printed).toHaveLength(0);
  });
});
