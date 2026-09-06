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
// Guard's discriminator for the two shapes, both from one leak:
//   GIT_DIR = a plain .git             -> identity poison + a tree-deleting commit; core.bare untouched
//   GIT_DIR = .git/worktrees/<name>    -> a single `git init` writes core.bare=true into the
//                                         SHARED config, because `bare` is a common-config key
// Which is why the isolation unit for provoking this is a SEPARATE CLONE, never a worktree:
// a linked worktree shares .git/config with the parent.
//
// Three tests, because the defect has three halves and any one alone leaves it live: the hook
// SOURCE must not leak, the hook THAT ACTUALLY RUNS must not leak, and a test must not depend
// on its caller having been careful.
import { strict as assert } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAKED_GIT_ENV, scrubLeakedGitEnv } from '../../helpers/git-env';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// F3 — THIS FILE MUST NOT REPRODUCE THE DEFECT IT DOCUMENTS.
//
// The init() helper below runs `git init`, `git config`, `git add` and `git commit` with a
// `cwd` and NO env override. That is correct-looking and wrong for exactly the reason this
// file exists: run under the pre-push hook, the ambient GIT_DIR wins and those calls land in
// the repository being pushed. Guard reproduced both effects from this very helper — a
// poisoned user.name/user.email and a commit that deleted the tree.
//
// Module scope, before any test runs a git command. The one call that DELIBERATELY sets
// GIT_DIR (the negative control) passes it explicitly in `env`, so it is unaffected — and it
// is now provably deliberate rather than possibly ambient, which is the point.
scrubLeakedGitEnv();

/**
 * Resolve the hook git will ACTUALLY run, honouring core.hooksPath.
 *
 * Reading `scripts/hooks/pre-push` proves what is in the tree. It says nothing about what
 * executes — which is the entire F1 finding: the repaired source sat in the tree while a
 * stale copy in .git/hooks kept running, so merging the fix disarmed nothing.
 */
function resolveEffectiveHook(): { path: string; exists: boolean; hooksPath: string | null } {
  let hooksPath: string | null = null;
  try {
    hooksPath =
      execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: REPO,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
  } catch {
    hooksPath = null; // unset: `git config --get` exits 1, which is not an error here
  }

  const path = hooksPath
    ? join(isAbsolute(hooksPath) ? hooksPath : join(REPO, hooksPath), 'pre-push')
    : execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-push'], {
        cwd: REPO,
        encoding: 'utf-8',
      }).trim();

  return { path, exists: existsSync(path), hooksPath };
}

function assertUnsetsEveryVariable(source: string, label: string): void {
  // Slice at the line that RUNS the build, not at the first mention of it: the hook's own
  // header comment says "Runs npm run build && npm test", so indexOf('npm run build') lands
  // on line 4 and the window excludes the very unsets it is meant to inspect. This caught
  // exactly that on its first run.
  // WHERE "WORK" BEGINS, and this locator has now been wrong twice for opposite reasons.
  //
  // First it was `indexOf('npm run build')`, which matched the hook's own HEADER COMMENT on line 4
  // and sliced a window that excluded the very unsets it was meant to inspect — a check that could
  // only pass.
  //
  // Then the hook stopped running the build inline: it now unsets, then `exec`s the not-worse gate,
  // which builds and tests in the exec'd process. `indexOf('if ! npm run build')` returned -1 and the
  // test failed — CORRECTLY, in the sense that it noticed, but for a reason that is not a defect.
  //
  // So locate the FIRST line that actually does work, under either shape, and fail loudly if neither
  // exists rather than silently slicing the whole file (which would make every assertion below pass).
  // `exec` is a legitimate boundary: it REPLACES the process, so a variable unset before it is unset
  // for everything the gate then runs.
  const workMarkers = [/^\s*if ! npm run build/m, /^\s*exec\s+/m];
  const positions = workMarkers
    .map((re) => source.search(re))
    .filter((i) => i > 0);
  expect(
    positions.length,
    `${label}: found no line that runs the build or execs a gate — this test can no longer locate ` +
      `where the hook starts doing work, so it cannot prove the unsets come first. Update the ` +
      `markers deliberately; do NOT widen the slice to make this pass.`,
  ).toBeGreaterThan(0);
  const runsBuild = Math.min(...positions);
  const unsetBeforeWork = source.slice(0, runsBuild);
  for (const key of LEAKED_GIT_ENV) {
    expect(
      new RegExp(`unset(\\s+[A-Z_]+)*\\s+${key}\\b`).test(unsetBeforeWork),
      `${label}: ${key} is not unset before the hook runs the build and the suite`,
    ).toBe(true);
  }
}

describe('git plumbing env must not leak from the pre-push hook into the test suite', () => {
  it('the hook SOURCE unsets every variable git exports to it', () => {
    assertUnsetsEveryVariable(readFileSync(join(REPO, 'scripts', 'hooks', 'pre-push'), 'utf-8'), 'hook source');
  });

  // F2 — THE HOOK THAT ACTUALLY RUNS, not the one in the tree.
  //
  // Absence must be LOUD. If this returned early on a missing hook it would report a green
  // over a clone whose real state is unknown, which is the same lie as the stale copy: a
  // reassuring result standing in for a fact nobody checked.
  it('the EFFECTIVE hook unsets them too — a merge fixes the source, not the copy that runs', (ctx) => {
    const hook = resolveEffectiveHook();

    if (!hook.exists) {
      ctx.skip(
        `SKIPPED, NOT PASSED — no pre-push hook is installed for this clone. ` +
          `Looked at: ${hook.path} (core.hooksPath=${hook.hooksPath ?? '<unset>'}). ` +
          `Nothing is gating pushes here, so there is nothing to verify. ` +
          `Run: bash scripts/setup-hooks.sh`,
      );
      return;
    }

    assertUnsetsEveryVariable(
      readFileSync(hook.path, 'utf-8'),
      `EFFECTIVE hook (${hook.path}, core.hooksPath=${hook.hooksPath ?? '<unset>'}) — ` +
        `this is a COPY that has fallen behind scripts/hooks/pre-push; ` +
        `run 'bash scripts/setup-hooks.sh' to point core.hooksPath at the tracked hooks`,
    );
  });

  // THE BEHAVIOURAL HALF. The assertions above read files and would keep passing if git
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
      for (const key of LEAKED_GIT_ENV) delete scrubbed[key];
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
