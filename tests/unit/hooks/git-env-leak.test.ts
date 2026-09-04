// A GATE MUST NOT REWRITE THE TREE IT IS GATING.
//
// The pre-push hook runs `npm test`. Git exports GIT_DIR (and friends) to every hook, and
// GIT_DIR OVERRIDES cwd-based repository discovery — so a `git` call passing `cwd: <temp dir>`,
// which reads as perfectly scoped, writes into the repository being pushed instead.
//
// Observed 2026-09-04: an aborted pre-push left FIVE "fixture" commits stacked on the branch
// and 29 files dirty. Reproduced with one variable changed, on
// tests/unit/lifecycle/legacy-status.test.ts:
//   without GIT_DIR:  45/45 pass, 0 commits, 0 dirty
//   with    GIT_DIR:  3 fail, 5 commits, 29 dirty
// The failures were caused by the leak too, so the hook manufactured the red it then refused
// to push on.
//
// Two tests, because the defect has two halves and either alone leaves it live: the hook must
// not leak, AND a test must not depend on its caller having been careful.
import { strict as assert } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const LEAKED = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
];

describe('git plumbing env must not leak from the pre-push hook into the test suite', () => {
  it('the hook source unsets every variable git exports to it', () => {
    const hook = readFileSync(join(REPO, 'scripts', 'hooks', 'pre-push'), 'utf-8');
    // Slice at the line that RUNS the build, not at the first mention of it: the hook's own
    // header comment says "Runs npm run build && npm test", so indexOf('npm run build') lands
    // on line 4 and the window excludes the very unsets it is meant to inspect. This test
    // caught exactly that on its first run.
    const runsBuild = hook.indexOf('if ! npm run build');
    expect(runsBuild, 'the hook no longer runs the build the way this test locates it').toBeGreaterThan(0);
    const unsetBeforeWork = hook.slice(0, runsBuild);
    for (const key of LEAKED) {
      expect(
        new RegExp(`unset(\\s+[A-Z_]+)*\\s+${key}\\b`).test(unsetBeforeWork),
        `${key} is not unset before the hook runs the build and the suite`,
      ).toBe(true);
    }
  });

  // THE BEHAVIOURAL HALF. The assertion above reads a file and would keep passing if git
  // changed what it exports; this one demonstrates the actual mechanism, so the reader can
  // see WHY the unset matters rather than taking the comment's word for it.
  it('GIT_DIR beats cwd, which is the whole defect — and clearing it restores cwd', () => {
    const decoy = mkdtempSync(join(tmpdir(), 'gitenv-decoy-'));
    const target = mkdtempSync(join(tmpdir(), 'gitenv-target-'));
    const init = (dir: string) => {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Env Leak Test'], { cwd: dir });
      writeFileSync(join(dir, 'seed.txt'), 'seed', 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'seed'], { cwd: dir, stdio: 'ignore' });
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
    };
    const decoyBefore = init(decoy);
    const targetBefore = init(target);
    const headOf = (dir: string) =>
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();

    try {
      // NEGATIVE CONTROL — the defect itself. cwd says `target`, GIT_DIR says `decoy`, and
      // GIT_DIR wins. Without this the test below could pass for the wrong reason.
      writeFileSync(join(target, 'a.txt'), 'a', 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: decoy });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'leaked'], {
        cwd: target,
        stdio: 'ignore',
        env: { ...process.env, GIT_DIR: join(decoy, '.git') },
      });
      expect(headOf(decoy), 'GIT_DIR did not override cwd — the premise of this test is gone').not.toBe(decoyBefore);
      expect(headOf(target), 'cwd should have been ignored while GIT_DIR was set').toBe(targetBefore);

      // THE FIX. Same call, same ambient GIT_DIR, scrubbed before spawning: cwd governs again.
      const decoyAfterLeak = headOf(decoy);
      const scrubbed = { ...process.env, GIT_DIR: join(decoy, '.git') };
      for (const key of LEAKED) delete scrubbed[key];
      execFileSync('git', ['commit', '--allow-empty', '-m', 'scrubbed'], {
        cwd: target,
        stdio: 'ignore',
        env: scrubbed,
      });
      expect(headOf(target), 'the scrubbed call did not commit where cwd pointed').not.toBe(targetBefore);
      expect(headOf(decoy), 'the scrubbed call still reached the decoy — the scrub is incomplete').toBe(decoyAfterLeak);
    } finally {
      rmSync(decoy, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
    assert.ok(true);
  });
});
