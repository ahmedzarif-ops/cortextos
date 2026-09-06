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
// The defect has three halves and any one alone leaves it live: the hook SOURCE must not leak,
// the hook THAT ACTUALLY RUNS must not leak, and a test must not depend on its caller having
// been careful. (This sentence used to open "Three tests, because…". A second variable family
// was added below and the number went stale in the same commit that made it wrong — so it is
// stated without a count, which cannot go stale, rather than bumped to a number that can.)
//
// ⛔ TWO FAMILIES NOW, AND THE SECOND ONE IS THE POINT OF THE FIRST BEING INCOMPLETE.
// `GIT_*` was the family somebody enumerated. `CTX_*` leaks through the same hook, by the same
// mechanism, and was not covered: a push from a live agent shell hands the suite that agent's
// real CTX_ROOT / CTX_AGENT_DIR / CTX_ORG. Measured 2026-09-09 on PR #39 from a live seat:
// 29 failed with them, 0 failed without, totals identical at 2786 — the environment flipping
// tests, not any code. See the CTX_ block at the bottom of this file.
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

/**
 * Byte offset of the first line where the hook starts DOING WORK.
 *
 * ONE LOCATOR, USED BY BOTH VARIABLE FAMILIES. There were two — this one, and a plain
 * `indexOf('if ! npm run build')` inside the CTX_ helper below — and the second broke the moment
 * the hook stopped running the build inline. Two locators for one concept is the drift this file
 * warns about everywhere else, committed inside the file that warns about it.
 *
 * This has now been wrong twice, for opposite reasons, which is why it is a function and not a
 * string:
 *   - `indexOf('npm run build')` matched the hook's own HEADER COMMENT on line 4 and sliced a
 *     window that excluded the very unsets it was meant to inspect — a check that could only pass.
 *   - Then the hook stopped building inline: it unsets, then `exec`s the not-worse gate, which
 *     builds and tests in the exec'd process. `indexOf('if ! npm run build')` returned -1.
 *
 * `exec` is a legitimate boundary: it REPLACES the process, so a variable unset before it is unset
 * for everything the gate then runs. Fail LOUDLY when no marker matches rather than slicing the
 * whole file, which would make every assertion downstream pass over an empty question.
 */
function startOfWork(source: string, label: string): number {
  const workMarkers = [/^\s*if ! npm run build/m, /^\s*exec\s+/m];
  const positions = workMarkers.map((re) => source.search(re)).filter((i) => i > 0);
  expect(
    positions.length,
    `${label}: found no line that runs the build or execs a gate — this test can no longer locate ` +
      `where the hook starts doing work, so it cannot prove the unsets come first. Update the ` +
      `markers deliberately; do NOT widen the slice to make this pass.`,
  ).toBeGreaterThan(0);
  return Math.min(...positions);
}

function assertUnsetsEveryVariable(source: string, label: string): void {
  // The locator and its history now live in startOfWork() — one copy, used by both families.
  const unsetBeforeWork = source.slice(0, startOfWork(source, label));
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SECOND FAMILY: CTX_*
//
// Same hook, same mechanism, different variables — and the reason it needs its own block rather
// than another entry in LEAKED_GIT_ENV is that the correct fix here is NOT a list. `GIT_*` is a
// closed set that git defines; `CTX_*` is an open set this project keeps adding to, so a
// hardcoded list would be correct on the day it was written and quietly incomplete afterwards,
// which is precisely how the GIT_* line above came to be right and insufficient at the same
// time. The hook therefore unsets DYNAMICALLY (`compgen -v CTX_`), and these tests assert the
// dynamic form, not merely that some CTX_ variable is mentioned.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The hook text that runs BEFORE any build or test — the part that is supposed to be a scrub. */
function preludeOf(source: string, label: string): string {
  return source.slice(0, startOfWork(source, label));
}

function assertStripsCtxDynamically(source: string, label: string): void {
  const prelude = preludeOf(source, label);
  expect(
    /compgen\s+-v\s+CTX_/.test(prelude),
    `${label}: CTX_* is not stripped dynamically before the hook runs the build and the suite. ` +
      `A hardcoded list is not an acceptable substitute here — it is a claim about the variables ` +
      `someone remembered on one day, and CTX_* is an open set.`,
  ).toBe(true);
  expect(
    /unset\s+"?\$/.test(prelude),
    `${label}: the CTX_ names are enumerated but never unset`,
  ).toBe(true);
}

describe('cortextOS CTX_* env must not leak from the pre-push hook into the test suite', () => {
  it('the hook SOURCE strips CTX_* dynamically before it does any work', () => {
    assertStripsCtxDynamically(
      readFileSync(join(REPO, 'scripts', 'hooks', 'pre-push'), 'utf-8'),
      'hook source',
    );
  });

  // Same F2 reasoning as above, and absence is LOUD for the same reason: a merge fixes the
  // source, not whatever copy git actually executes.
  it('the EFFECTIVE hook strips them too', (ctx) => {
    const hook = resolveEffectiveHook();
    if (!hook.exists) {
      ctx.skip(
        `SKIPPED, NOT PASSED — no pre-push hook is installed for this clone. ` +
          `Looked at: ${hook.path} (core.hooksPath=${hook.hooksPath ?? '<unset>'}). ` +
          `Run: bash scripts/setup-hooks.sh`,
      );
      return;
    }
    assertStripsCtxDynamically(
      readFileSync(hook.path, 'utf-8'),
      `EFFECTIVE hook (${hook.path}, core.hooksPath=${hook.hooksPath ?? '<unset>'})`,
    );
  });

  // THE BEHAVIOURAL HALF, and it EXECUTES THE HOOK'S OWN TEXT rather than describing it.
  //
  // The two assertions above read a file and would keep passing if the loop were syntactically
  // broken, or if `set -euo pipefail` made an empty `compgen` abort the hook before it ever
  // reached the build. This one runs the real prelude, sliced out of the real file, in bash.
  it('running the hook prelude actually removes CTX_* — including a name nobody hardcoded', () => {
    const source = readFileSync(join(REPO, 'scripts', 'hooks', 'pre-push'), 'utf-8');
    const prelude = preludeOf(source, 'hook source');

    // A variable no list in this repo contains. If the hook ever regresses to a hardcoded
    // enumeration, this one survives it and the test goes red.
    const planted = {
      CTX_ROOT: '/live/seat/root',
      CTX_AGENT_DIR: '/live/seat/agents/sentinel',
      CTX_FUTURE_VARIABLE_NOBODY_HARDCODED: 'planted',
    };
    // ⚠ READ THE LAST LINE, NOT THE WHOLE OUTPUT. The prelude ends with the hook's own
    // `echo "[pre-push] Running build..."`, so the raw output is two lines and `Number(...)` of
    // it is NaN. The first run of this test failed with "the planted variables did not survive"
    // — an accusation against the CONTROL for what was a parsing bug in the READER. A count
    // that arrives as NaN is not a small number, and a message that blames the subject for the
    // instrument's defect is the most expensive kind of red.
    const run = (script: string) => {
      const out = execFileSync('bash', ['-c', `${script}\nenv | grep -c '^CTX_' || true`], {
        cwd: REPO,
        encoding: 'utf-8',
        env: { ...process.env, ...planted },
      }).trim();
      const last = out.split('\n').pop() ?? '';
      const n = Number(last);
      expect(Number.isFinite(n), `could not read a count from the prelude output: ${JSON.stringify(out)}`).toBe(true);
      return n;
    };

    // NEGATIVE CONTROL — the planted variables must actually REACH a bash child. Without this,
    // a zero below could mean "the scrub works" or "there was nothing to remove", and those are
    // different facts that look identical.
    //
    // ⚠ THE CONTROL IS AN EMPTY SCRIPT, NOT "THE PRELUDE WITH THE SCRUB CUT OUT". The first
    // version did the latter, by regex. It worked against a mutant that DELETED the loop and
    // fell over against the one that matters — a mutant replacing the dynamic loop with a
    // HARDCODED list — because the regex could no longer find anything to cut, so the test
    // failed with "the scrub was not located" instead of demonstrating that the planted future
    // variable survived. A control that is derived from the subject stops working exactly when
    // the subject changes shape, which is the moment you need it.
    expect(
      run(':'),
      'the planted CTX_ variables did not reach a bash child at all — the control cannot fail, so the assertion below proves nothing',
    ).toBeGreaterThanOrEqual(Object.keys(planted).length);

    // THE ASSERTION.
    expect(
      run(prelude),
      'CTX_* survived the hook prelude — a push from a live agent shell will hand the suite that seat\'s real directories',
    ).toBe(0);
  });
});
