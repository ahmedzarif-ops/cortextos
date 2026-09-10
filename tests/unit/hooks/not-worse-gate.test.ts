import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE GATE MUST NOT TURN A RUNNER FAILURE INTO A GREEN PUSH.
 *
 * `run_suite` used to discard `npm test`'s exit status, and `extract_failures` matched only lines
 * beginning `FAIL`. Real Vitest exits 1 with every assertion passing when it catches an unhandled
 * rejection: the report says `Errors  1 error` and prints an Unhandled Errors block with NO `FAIL`
 * entry. The gate extracted zero rows, short-circuited to
 * "no failures on the working tree — nothing to compare. PASS." and never fetched a baseline —
 * MORE permissive than the not-worse policy it advertises, because it admitted a brand-new runner
 * failure without consulting main at all. Found by guard, 2026-09-09, against real Vitest.
 *
 * ⚠ THESE ARE GUARD'S THREE FIXTURES, REUSED RATHER THAN RE-DERIVED. A control I rebuild from my
 * own reading of the defect inherits my reading of it; the point of a control is that it does not.
 *
 * ⛔ AND WHY THE PROCESS-LEVEL ARMS ASSERT A MESSAGE, NOT JUST AN EXIT CODE: in a fixture with no
 * remote, the unhandled arm and the ordinary-failure arm BOTH end up refusing — one because it now
 * extracts a row and cannot reach a baseline, the other for the same reason. Exit code alone
 * cannot tell "the row was extracted" from "it refused for some other reason", and the whole
 * defect was a refusal that did not happen. So each arm asserts the sentence that names WHY.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATE = join(REPO, 'scripts', 'hooks', 'lib', 'not-worse-gate.sh');
const FUNCTIONS_END_MARKER = '# ---- functions end ----';

// ⛔ THE FIXTURE OWNS ITS OWN node_modules, IN A CACHE OUTSIDE EVERY TREE, AND THIS IS A SAFETY
// ⛔ PROPERTY RATHER THAN A CONVENIENCE.
//
// The gate now PREPARES each side (`npm install`, `npm install --prefix dashboard`, build) before
// running it. The old fixture symlinked node_modules straight at THIS repo's — so the gate's install
// would have run against /…/cortextos/node_modules, and a fixture that declares no dependencies
// entitles npm to prune everything it finds there as extraneous. That is not a risk worth taking to
// save an install.
//
// So: one install per SUITE into a fixture-owned cache (never eleven, never the real repo), and the
// fixture repo commits `node_modules` as a TRACKED SYMLINK to that cache. Tracked, because the gate
// creates its head worktree at a path this test does not choose — only a committed symlink survives
// the checkout into it. Real Vitest still runs in every arm, which is the property guard's fixtures
// were built for and the one thing not worth trading away for speed.
let cacheDir: string;
let cacheModules: string;

// Guard's three fixtures, byte-for-byte.
const FIXTURES = {
  green: "import { it, expect } from 'vitest'; it('green companion',()=>expect(true).toBe(true));\n",
  unhandled:
    "import { it, expect } from 'vitest'; it('green assertion with runner failure',async()=>{setTimeout(()=>{Promise.reject(new Error('GUARD_UNHANDLED_CONTROL'))},0);await new Promise(r=>setTimeout(r,30));expect(true).toBe(true)});\n",
  assertion: "import { it, expect } from 'vitest'; it('ordinary red control',()=>expect(false).toBe(true));\n",
  // Guard's second-round fixtures, copied verbatim from its report directory.
  // KNOWN: one nameable unhandled error — the inherited case, which must still be accepted.
  known:
    "import { it, expect } from 'vitest'; it('passed assertion',async()=>{setTimeout(()=>{Promise.reject(new Error('GUARD_KNOWN_BASELINE'))},0);await new Promise(r=>setTimeout(r,30));expect(true).toBe(true)});\n",
  // MIXED: the same known error PLUS a rejection of a bare object, which Vitest renders as a
  // Serialized Error with no `Error:` headline. Reporter says `Errors  2 errors`; the extractor can
  // name ONE. That gap is the whole defect.
  mixed:
    "import { it, expect } from 'vitest'; it('passed assertion',async()=>{setTimeout(()=>{Promise.reject(new Error('GUARD_KNOWN_BASELINE'));Promise.reject({code:'GUARD_NEW_UNNAMEABLE'})},0);await new Promise(r=>setTimeout(r,30));expect(true).toBe(true)});\n",
} as const;

// Allow-listed environment, and NO CTX_*/GIT_* — the fixture is a separate git repo and must not
// inherit this one. NO_COLOR keeps the reporter's plain output explicit.
const ENV: NodeJS.ProcessEnv = { CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' };
for (const k of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG']) {
  if (process.env[k]) ENV[k] = process.env[k];
}

let fixture: string;

const FIXTURE_PKG = {
  name: 'not-worse-gate-fixture',
  private: true,
  scripts: { build: 'node -e "process.exit(0)"', test: 'vitest run' },
  // ⛔ EXACT PIN, NOT A RANGE, and it is not tidiness. `vitest: "^4.1.2"` makes npm 10.9.8 resolve
  // the range's peer set and it crashes: `Cannot read properties of null (reading 'edgesOut')` in
  // arborist's #loadPeerSet, on this machine, with a warm cache and the registry reachable.
  // Measured: `^4.1.2` rc 1 every time; `4.1.2` with --legacy-peer-deps rc 0, 44 packages, 2s.
  devDependencies: { vitest: '4.1.2' },
} as const;

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, env: { ...ENV, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'f@x' } });
}

beforeAll(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'not-worse-gate-cache-'));
  writeFileSync(join(cacheDir, 'package.json'), JSON.stringify(FIXTURE_PKG));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', '--legacy-peer-deps'], {
    cwd: cacheDir,
    env: ENV,
  });
  cacheModules = join(cacheDir, 'node_modules');

  fixture = mkdtempSync(join(tmpdir(), 'not-worse-gate-'));
  execFileSync('git', ['init', '-q', '-b', 'main', fixture]);
  symlinkSync(cacheModules, join(fixture, 'node_modules'), 'dir');
  writeFileSync(join(fixture, 'package.json'), JSON.stringify(FIXTURE_PKG));
  // ⛔ THE LOCKFILE IS WHAT MAKES THE GATE'S OWN `npm install` A NO-OP RATHER THAN A RESOLUTION.
  // Without it, prepare_tree's install inside the head worktree re-resolves from the registry and
  // hits the same arborist crash the exact pin above documents. With it, npm reads the tree it is
  // told about, finds it satisfied through the symlink, and writes nothing.
  // MEASURED: cache listing hash identical before and after a plain `npm install` in a tree whose
  // node_modules is that symlink.
  writeFileSync(join(fixture, 'package-lock.json'), readFileSync(join(cacheDir, 'package-lock.json'), 'utf-8'));
  // The gate installs dashboard deps on both sides; the fixture must model a repo that has one.
  mkdirSync(join(fixture, 'dashboard'), { recursive: true });
  writeFileSync(
    join(fixture, 'dashboard', 'package.json'),
    JSON.stringify({ name: 'not-worse-gate-fixture-dashboard', private: true, version: '0.0.0' }),
  );
  // The gate's prerequisite control runs THIS file as its own invocation on each side. Green here;
  // case 12 replaces it with a failing one to prove the control refuses and names the side.
  mkdirSync(join(fixture, 'tests', 'unit'), { recursive: true });
  writeFileSync(
    join(fixture, 'tests', 'unit', 'prerequisites.test.ts'),
    "import { it, expect } from 'vitest'; it('prerequisites present',()=>expect(true).toBe(true));\n",
  );
  git(['add', '-A'], fixture);
  git(['commit', '-qm', 'fixture base'], fixture);
});

afterAll(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

function run(kind: keyof typeof FIXTURES) {
  // ⚠ COMMITTED, NOT MERELY WRITTEN. The gate tests HEAD in a worktree now, not the working tree —
  // a deliberate change (a push carries commits), and an uncommitted fixture would be invisible to
  // it. The `npm test` companion below still runs in the working tree, which is what makes it a
  // companion: it establishes the premise independently of the gate.
  writeFileSync(join(fixture, 'gate.test.ts'), FIXTURES[kind]);
  git(['add', '-A'], fixture);
  git(['commit', '-qm', `fixture ${kind}`, '--allow-empty'], fixture);
  const npm = spawnSync('npm', ['test'], { cwd: fixture, env: ENV, encoding: 'utf-8' });
  const gate = spawnSync('bash', [GATE], { cwd: fixture, env: ENV, encoding: 'utf-8' });
  return { npmStatus: npm.status, gateStatus: gate.status, out: (gate.stdout ?? '') + (gate.stderr ?? '') };
}

describe('not-worse gate: a runner failure is never a green push', () => {
  it('C1 GREEN COMPANION: a passing suite still short-circuits to PASS', () => {
    const r = run('green');
    expect(r.npmStatus, 'the green fixture did not exit 0 — the companion is not green').toBe(0);
    expect(r.gateStatus).toBe(0);
    expect(r.out).toContain('no failures on the head worktree');
  }, 60_000);

  it('C2 THE BLOCKING ROW: passing assertions + an unhandled rejection must NOT pass', () => {
    const r = run('unhandled');
    // The premise: real Vitest really does exit non-zero here with no FAIL line.
    expect(r.npmStatus, 'the unhandled fixture did not exit non-zero — the premise is gone').not.toBe(0);
    expect(
      r.gateStatus,
      'the gate accepted a run the runner rejected — this is the exact defect: ' +
        'an unhandled rejection with no FAIL line read as "no failures"',
    ).not.toBe(0);
    // WHY it refused, not merely that it did: the UNHANDLED row was extracted and counted.
    expect(r.out).toContain('head has 1 failing entr');
    expect(r.out).not.toContain('no failures on the head worktree');
  }, 60_000);

  // ⛔ THE ARM THAT ISOLATES THE EXIT STATUS, and it needs a runner that is not Vitest.
  //
  // C2 above is refused for TWO independent reasons once fixed — the status is non-zero AND an
  // UNHANDLED row is extracted — so it cannot tell which repair is load-bearing. A mutant that
  // discards the status alone would still be caught by the row. This arm removes the row: a
  // runner that prints a perfectly valid summary and exits 1 with nothing failing. That is exactly
  // "failures I cannot name", and it is reachable ONLY through the retained exit status.
  it('C8 EXIT STATUS ALONE: a valid summary with a non-zero runner exit must fail closed', () => {
    // ⚠ COMMITTED, like every other fixture mutation: the gate reads HEAD, so a package.json that
    // only exists in the working tree would leave the gate running the ordinary vitest script and
    // this arm would pass for the wrong reason.
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({
        ...FIXTURE_PKG,
        scripts: {
          build: 'node -e "process.exit(0)"',
          test: 'node -e "console.log(\' Test Files  1 passed (1)\');console.log(\'      Tests  1 passed (1)\');process.exit(1)"',
        },
      }),
    );
    git(['add', '-A'], fixture);
    git(['commit', '-qm', 'C8 runner exits 1 with a clean summary', '--allow-empty'], fixture);
    try {
      const gate = spawnSync('bash', [GATE], { cwd: fixture, env: ENV, encoding: 'utf-8' });
      const out = (gate.stdout ?? '') + (gate.stderr ?? '');
      expect(gate.status, 'a non-zero runner exit with no nameable failure was accepted').not.toBe(0);
      expect(out).toContain('failures I cannot name');
      expect(out).not.toContain('no failures on the head worktree');
    } finally {
      writeFileSync(join(fixture, 'package.json'), JSON.stringify(FIXTURE_PKG));
      git(['add', '-A'], fixture);
      git(['commit', '-qm', 'restore fixture package.json', '--allow-empty'], fixture);
    }
  }, 60_000);

  // ⛔ THE SECOND FAIL, AND IT IS THE MORE INSTRUCTIVE ONE: PARTIAL CAPTURE.
  //
  // The first fix's "cardinality control" rejected only `declared > 0 && named == 0` — an EXISTENCE
  // check wearing a cardinality check's name. Guard broke it in one move: a baseline carrying one
  // nameable error, a branch adding one UNNAMEABLE one. declared 2 / named 1 / npm 1. The extractor
  // emits the inherited row only, the comparison finds nothing new, and the gate PASSES a
  // brand-new runner failure as "not worse".
  //
  // ⭐ ZERO CAPTURE IS LOUD. PARTIAL CAPTURE LOOKS EXACTLY LIKE A CLEAN READ OF A SMALLER PROBLEM.
  it('C9 KNOWN-ERROR COMPANION: one nameable unhandled error is still named, counts agree', () => {
    const r = run('known');
    expect(r.npmStatus, 'the known fixture did not exit non-zero — the premise is gone').not.toBe(0);
    // It is refused here only because this fixture has no remote to compare against; what this arm
    // pins is that the counts RECONCILE, so the refusal is about the baseline and not about naming.
    expect(r.out).toContain('head has 1 failing entr');
    expect(r.out).not.toContain('could name');
  }, 60_000);

  it('C10 PARTIAL CAPTURE: declared 2, nameable 1 — must refuse with both counts', () => {
    const r = run('mixed');
    expect(r.npmStatus, 'the mixed fixture did not exit non-zero — the premise is gone').not.toBe(0);
    expect(
      r.gateStatus,
      'a run whose runner errors were only PARTIALLY extracted was accepted — the new unnameable ' +
        'failure would have been admitted as "not worse"',
    ).not.toBe(0);
    // The sentence must carry BOTH numbers, or the reader cannot tell partial from total.
    expect(r.out).toContain('reported 2 runner error(s) and this gate could name 1 of them');
    expect(r.out).not.toContain('no failures on the head worktree');
  }, 60_000);

  it('C3 ORDINARY FAILURE: still recognised and still refused', () => {
    const r = run('assertion');
    expect(r.npmStatus).not.toBe(0);
    expect(r.gateStatus).not.toBe(0);
    expect(r.out).toContain('head has 1 failing entr');
  }, 60_000);
});

/**
 * The refusals, exercised at function level against crafted reporter output.
 *
 * These need no npm run: they source the gate's functions and feed them a file. That is
 * deliberate — the three arms above prove the behaviour end to end and are slow; these prove the
 * REFUSAL SET is complete and are fast, and a reporter-shape change breaks them first.
 */
function callFunctions(script: string, outFile: string, content: string) {
  const gateSrc = readFileSync(GATE, 'utf-8');
  // ⛔ CUT ON A DECLARED MARKER, NOT ON PROSE. This used to cut at the literal
  // `say "building working tree..."`. That line was renamed when the gate moved its head build into
  // a worktree, indexOf returned -1, and EIGHT arms below failed on a LOCATOR while their messages
  // named assertions — loud, and pointing at the wrong thing. The gate now carries
  // `# ---- functions end ----` as a declared interface, and the comment beside it forbids moving it
  // without changing this file in the same commit.
  const cut = gateSrc.indexOf(FUNCTIONS_END_MARKER);
  expect(
    cut,
    `cannot find ${FUNCTIONS_END_MARKER} in the gate — the marker is an interface between these two ` +
      'files and something moved it',
  ).toBeGreaterThan(0);
  const prelude = gateSrc.slice(0, cut);
  writeFileSync(outFile, content);
  return spawnSync('bash', ['-c', `${prelude}\n${script}`], { cwd: fixture, env: ENV, encoding: 'utf-8' });
}

describe('not-worse gate: the refusal set', () => {
  // ⛔ THIS ARM HAD TO BE REBUILT: THE FIRST VERSION DID NOT TEST WHAT IT NAMED.
  //
  // It fed a summary declaring 1 error with no failure rows — which is ALSO caught by the
  // "non-zero exit, zero rows" refusal, so the cardinality control could be DELETED and this test
  // still passed. Mutant G3 (replace the cardinality condition with `if false`) survived, which is
  // how it was found: an unkilled mutant is a lead to chase, not a result to explain.
  //
  // To isolate it, the input must fail ONLY that check: a real FAIL row present (so `count > 0`
  // defeats the zero-rows refusal), a non-zero exit (so the rc==0 refusal cannot fire), and a
  // summary DECLARING an error the extractor produced no UNHANDLED row for. That combination is
  // exactly "the reporter moved and the parser is behind it", and nothing else catches it.
  it('C4 RECONCILIATION, TOTAL-MISS ARM: declared 1, nameable 0, isolated', () => {
    const out = join(fixture, 'c4.out');
    const r = callFunctions(
      `SUITE_SUMMARY=1; extract_failures "${out}" > "${out}.fails"; assert_nameable "${out}" "${out}.fails" 1 "working tree"`,
      out,
      [
        'FAIL  tests/whatever.test.ts > an ordinary failure',
        '',
        '⎯⎯ Some Future Runner Error Section ⎯⎯',
        'the reporter changed shape and this parser does not know it',
        '',
        ' Test Files  1 failed (1)',
        '      Tests  1 failed (1)',
        '     Errors  1 error',
        '',
      ].join('\n'),
    );
    const text = (r.stdout ?? '') + (r.stderr ?? '');
    expect(r.status, 'a declared runner error with no extracted row was accepted').not.toBe(0);
    expect(text).toContain('failures I cannot name');
    // The message must name the CARDINALITY, so the reader knows which refusal fired.
    // The message carries BOTH counts now, so total capture failure and partial capture failure
    // are distinguishable in the output rather than only in the code.
    expect(text).toContain('reported 1 runner error(s) and this gate could name 0 of them');
  });

  it('C5 non-zero exit with a readable summary and zero rows is "failures I cannot name"', () => {
    const out = join(fixture, 'c5.out');
    const r = callFunctions(
      `SUITE_SUMMARY=1; extract_failures "${out}" > "${out}.fails"; assert_nameable "${out}" "${out}.fails" 1 "working tree"`,
      out,
      ' Test Files  1 passed (1)\n      Tests  1 passed (1)\n',
    );
    expect(r.status).not.toBe(0);
    expect((r.stdout ?? '') + (r.stderr ?? '')).toContain('failures I cannot name');
  });

  // ⛔ THE TRAP INSIDE THE FIX: the reporter counts OCCURRENCES, `extract_failures` ends in
  // `sort -u`. Reconciling a declared count against DEDUPLICATED identities would refuse two
  // identical error messages — an ordinary thing — and the pressure would then be to relax the
  // check that was just added. Occurrences are counted before deduplication; this pins that.
  it('C11 DUPLICATE IDENTITIES: two identical errors reconcile, and dedup to one row', () => {
    const out = join(fixture, 'c11.out');
    const body = [
      '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
      '⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯',
      'Error: SAME_MESSAGE_TWICE',
      '⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯',
      'Error: SAME_MESSAGE_TWICE',
      '',
      ' Test Files  1 passed (1)',
      '      Tests  1 passed (1)',
      '     Errors  2 errors',
      '',
    ].join('\n');
    const accepted = callFunctions(
      `SUITE_SUMMARY=1; extract_failures "${out}" > "${out}.fails"; assert_nameable "${out}" "${out}.fails" 1 "working tree"`,
      out,
      body,
    );
    expect(
      accepted.status,
      'two identical error messages were treated as partial capture — the reconciliation is ' +
        'comparing occurrences against deduplicated identities',
    ).toBe(0);
    const rows = callFunctions(`extract_failures "${out}"`, out, body);
    expect((rows.stdout ?? '').trim().split('\n').filter(Boolean)).toEqual([
      'UNHANDLED Error: SAME_MESSAGE_TWICE',
    ]);
  });

  it('C6 GREEN COMPANION for the refusals: rc 0 with a clean summary is accepted', () => {
    const out = join(fixture, 'c6.out');
    const r = callFunctions(
      `SUITE_SUMMARY=1; extract_failures "${out}" > "${out}.fails"; assert_nameable "${out}" "${out}.fails" 0 "working tree"`,
      out,
      ' Test Files  1 passed (1)\n      Tests  1 passed (1)\n',
    );
    expect(r.status, 'the refusals fire on a clean run — they would block every push').toBe(0);
  });

  it('C7 EXTRACTION: a real Unhandled Errors block yields exactly one UNHANDLED row', () => {
    const out = join(fixture, 'c7.out');
    const r = callFunctions(
      `extract_failures "${out}"`,
      out,
      [
        '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
        '',
        'Vitest caught 1 unhandled error during the test run.',
        '',
        '⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯',
        'Error: GUARD_UNHANDLED_CONTROL',
        ' ❯ Timeout._onTimeout guard.test.ts:1:120',
        '',
        ' Test Files  1 passed (1)',
        '      Tests  1 passed (1)',
        '     Errors  1 error',
        '',
      ].join('\n'),
    );
    expect(r.status).toBe(0);
    const rows = (r.stdout ?? '').trim().split('\n').filter(Boolean);
    expect(rows).toEqual(['UNHANDLED Error: GUARD_UNHANDLED_CONTROL']);
  });
});

/**
 * CASES 12-14: the prerequisite control and the population check.
 *
 * ⛔ WHY THESE ARE PERMANENT ARMS AND NOT A ONE-TIME RECEIPT (chief's call, and it is the right one):
 * once the gate installs dashboard deps on BOTH sides, the control can only ever pass in production,
 * and a green that cannot go red carries no information. These arms are the only place the refusal
 * is ever exercised again.
 *
 * ⛔ AND THE REASON STRING IS ASSERTED, NOT JUST THE EXIT CODE. A control that aborts for ANY reason
 * is a coincidence: in a fixture there are half a dozen ways to make the gate exit 1, and every one
 * of them would satisfy `status !== 0`. The arm has to prove it refused for the reason it exists for.
 */
describe('not-worse gate: prerequisites and populations', () => {
  // A self-contained fixture WITH a remote, so the baseline half of the gate is reachable. The
  // shared fixture above deliberately has none — several of guard's arms depend on the gate dying at
  // the fetch — so this builds its own rather than changing the premise of an existing control.
  function remoteFixture() {
    const root = mkdtempSync(join(tmpdir(), 'not-worse-gate-remote-'));
    const bare = join(root, 'origin.git');
    const work = join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    symlinkSync(cacheModules, join(work, 'node_modules'), 'dir');
    writeFileSync(join(work, 'package.json'), JSON.stringify(FIXTURE_PKG));
    writeFileSync(join(work, 'package-lock.json'), readFileSync(join(cacheDir, 'package-lock.json'), 'utf-8'));
    mkdirSync(join(work, 'dashboard'), { recursive: true });
    writeFileSync(
      join(work, 'dashboard', 'package.json'),
      JSON.stringify({ name: 'fixture-dashboard', private: true, version: '0.0.0' }),
    );
    mkdirSync(join(work, 'tests', 'unit'), { recursive: true });
    return { root, bare, work };
  }

  function writePrereq(work: string, green: boolean) {
    writeFileSync(
      join(work, 'tests', 'unit', 'prerequisites.test.ts'),
      green
        ? "import { it, expect } from 'vitest'; it('prerequisites present',()=>expect(true).toBe(true));\n"
        : "import { it, expect } from 'vitest'; it('dashboard/ dependencies are installed',()=>expect(false).toBe(true));\n",
    );
  }

  function gateOn(work: string) {
    const gate = spawnSync('bash', [GATE], { cwd: work, env: ENV, encoding: 'utf-8' });
    return { status: gate.status, out: (gate.stdout ?? '') + (gate.stderr ?? '') };
  }

  it('case 12 HEAD SIDE: an unprepared head refuses by name, not merely by exit code', () => {
    const { root, work } = remoteFixture();
    try {
      writePrereq(work, false);
      writeFileSync(join(work, 'gate.test.ts'), FIXTURES.green);
      git(['add', '-A'], work);
      git(['commit', '-qm', 'head with a failing prerequisite'], work);

      const r = gateOn(work);
      expect(r.status, 'a tree whose prerequisites are not met was accepted').not.toBe(0);
      expect(r.out).toContain('gate-prerequisite-missing side=head');
      // It must NOT have reached the comparison — the whole point is that this refusal comes first.
      expect(r.out).not.toContain('no failures on the head worktree');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('case 12b BASE SIDE: an unprepared BASELINE refuses by name — the fail-open this PR closes', () => {
    const { root, bare, work } = remoteFixture();
    try {
      // origin/main carries the FAILING prerequisites file: this is the real-world shape, where the
      // baseline is the under-prepared side and its alarm is a base-only row that comm -13 erases.
      writePrereq(work, false);
      writeFileSync(join(work, 'gate.test.ts'), FIXTURES.green);
      git(['add', '-A'], work);
      git(['commit', '-qm', 'baseline with a failing prerequisite'], work);
      git(['remote', 'add', 'origin', bare], work);
      git(['push', '-q', 'origin', 'main'], work);

      // HEAD fixes the prerequisite AND introduces a failure, so the gate must compute a baseline.
      writePrereq(work, true);
      writeFileSync(join(work, 'gate.test.ts'), FIXTURES.assertion);
      git(['add', '-A'], work);
      git(['commit', '-qm', 'head fixes the prerequisite and adds a failure'], work);

      const r = gateOn(work);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('gate-prerequisite-missing side=base');
      // ⛔ AND IT MUST NOT HAVE PASSED THE COMPARISON. Before this change the baseline's own alarm
      // was a base-only row, which `comm -13` drops by construction — the baseline announced its
      // invalidity and the subtraction turned that into permission.
      expect(r.out).not.toContain('NOT WORSE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('case 13 POPULATIONS: equal totals with no test-file change reach the comparison', () => {
    const { root, bare, work } = remoteFixture();
    try {
      writePrereq(work, true);
      writeFileSync(join(work, 'gate.test.ts'), FIXTURES.green);
      git(['add', '-A'], work);
      git(['commit', '-qm', 'baseline'], work);
      git(['remote', 'add', 'origin', bare], work);
      git(['push', '-q', 'origin', 'main'], work);

      // Same test FILES on both sides, same number of tests — only the outcome changes. The strict
      // arm therefore applies and must be satisfied, so the gate reaches the set comparison and
      // refuses on the NEW FAILURE rather than on the populations.
      writeFileSync(join(work, 'gate.test.ts'), FIXTURES.assertion);
      git(['add', '-A'], work);
      git(['commit', '-qm', 'head turns the same test red'], work);

      const r = gateOn(work);
      expect(r.out).toContain('collected_base=');
      expect(r.out).toContain('test_files_added_or_removed=0');
      expect(r.out, 'the populations check fired on two identical suites').not.toContain('populations-differ');
      expect(r.status, 'a new failure was admitted').not.toBe(0);
      expect(r.out).toContain('NEW FAILURES NOT PRESENT ON');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
