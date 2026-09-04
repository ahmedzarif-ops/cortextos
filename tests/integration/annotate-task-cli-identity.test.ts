/**
 * annotate-task, driven through THE REAL CLI ENTRY PATH.
 *
 * Why this file exists (guard umoyf, review of PR #11 at 3c18b5e): every assertion in
 * `tests/unit/bus/annotate-task.test.ts` calls `annotateTask()` directly, including the one
 * that "proves" a note with no author is refused — it passes `''` as the agent. The CLI can
 * never produce that value. `resolveEnv().agentName` falls back to `basename(process.cwd())`,
 * so from the CLI the identity argument is never empty and that refusal is UNREACHABLE.
 *
 * The consequence is not a crash. It is a note signed `Desktop`, or `tmp`, or whatever
 * directory the process happened to start in — a wrong attribution that reads exactly like a
 * right one, on a record whose entire purpose is attribution.
 *
 * Two things this file does that the unit tests structurally cannot:
 *   1. It runs the actual command, so a fix that lives only in the library is not enough.
 *   2. It runs from a CLEAN cwd. Inside any agent directory a `.cortextos-env` supplies the
 *      identity and the refusal path never executes — the test would pass while proving
 *      nothing. That trap is asserted below rather than described, so it stays true.
 *
 * Isolation: HOME is redirected to a temp dir for the child, so `resolvePaths` (which builds
 * from `homedir()`) cannot reach the real ~/.cortextos store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTask, findTaskFile } from '../../src/bus/task';
import type { BusPaths, Task } from '../../src/types/index';

const ROOT = join(__dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = join(ROOT, 'src', 'cli', 'index.ts');

const ORG = 'testorg';
/** Distinctive so a cwd-basename signature is unmistakable if it ever reappears. */
const CWD_MARKER = 'cwd-basename-must-never-sign';

let home: string;
let cleanCwd: string;
let paths: BusPaths;
let taskId: string;

function runCli(args: string[], opts: { cwd: string; agentName?: string }) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CTX_ORG: ORG, CTX_INSTANCE_ID: 'default' };
  delete env.CTX_AGENT_NAME;
  delete env.CTX_ROOT;
  delete env.CTX_AGENT_DIR;
  if (opts.agentName) env.CTX_AGENT_NAME = opts.agentName;
  return spawnSync(TSX, [ENTRY, ...args], { encoding: 'utf8', cwd: opts.cwd, env });
}

function readTask(): Task {
  const f = findTaskFile(paths, taskId);
  expect(f).not.toBeNull();
  return JSON.parse(readFileSync(f as string, 'utf-8'));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'annotate-cli-home-'));
  // A clean cwd: a fresh directory with NO .cortextos-env in it.
  cleanCwd = join(mkdtempSync(join(tmpdir(), 'annotate-cli-')), CWD_MARKER);
  mkdirSync(cleanCwd, { recursive: true });

  // Mirror exactly what resolvePaths(agent, 'default', ORG) builds under the redirected HOME.
  const orgBase = join(home, '.cortextos', 'default', 'orgs', ORG);
  paths = { taskDir: join(orgBase, 'tasks'), eventDir: join(orgBase, 'events'), messageDir: join(orgBase, 'messages') } as BusPaths;
  taskId = createTask(paths, 'city', ORG, 'radar', { description: 'Original ask, must survive untouched.' });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cleanCwd, { recursive: true, force: true });
});

describe('annotate-task CLI identity', () => {
  it('REFUSES to sign a note with the cwd basename when no identity is supplied', () => {
    const r = runCli(['bus', 'annotate-task', taskId, 'a real correction'], { cwd: cleanCwd });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no agent identity/i);
    // The error must name a flag that EXISTS. Before this fix it advertised --agent while the
    // command had no such option, so following the instruction failed a second time.
    expect(r.stderr).toMatch(/--agent/);

    // The load-bearing assertion: nothing was written, and in particular nothing was written
    // under the directory name.
    const after = readTask();
    expect(after.annotations ?? []).toHaveLength(0);
    expect(JSON.stringify(after)).not.toContain(CWD_MARKER);
  });

  it('POSITIVE CONTROL: the same command from the same clean cwd SUCCEEDS with --agent', () => {
    const r = runCli(['bus', 'annotate-task', taskId, 'a real correction'], { cwd: cleanCwd });
    expect(r.status).not.toBe(0); // the refusal above, re-established in this test's own arm

    const ok = runCli(['bus', 'annotate-task', taskId, 'a real correction', '--agent', 'city'], { cwd: cleanCwd });
    expect(ok.status).toBe(0);

    const after = readTask();
    expect(after.annotations).toHaveLength(1);
    expect(after.annotations?.[0].agent).toBe('city');
    expect(after.annotations?.[0].text).toBe('a real correction');
    // The command's whole promise: the ask itself is untouched.
    expect(after.description).toBe('Original ask, must survive untouched.');
  });

  it('CTX_AGENT_NAME still signs the note — the fix removes the cwd guess, not the env var', () => {
    const r = runCli(['bus', 'annotate-task', taskId, 'from the env'], { cwd: cleanCwd, agentName: 'sentinel' });
    expect(r.status).toBe(0);
    expect(readTask().annotations?.[0].agent).toBe('sentinel');
  });

  it('--agent WINS over CTX_AGENT_NAME, so an explicit author is never silently overridden', () => {
    const r = runCli(['bus', 'annotate-task', taskId, 'explicit wins', '--agent', 'guard'], {
      cwd: cleanCwd,
      agentName: 'sentinel',
    });
    expect(r.status).toBe(0);
    expect(readTask().annotations?.[0].agent).toBe('guard');
  });

  /**
   * THE TRAP, ASSERTED RATHER THAN DESCRIBED. Chief's warning was that running this test from
   * an agent directory would let `.cortextos-env` supply the identity and fake a pass. This
   * proves that mechanism is real: same command, same missing CTX_AGENT_NAME, only the cwd
   * changed — and it succeeds. A future author who "tidies" the clean-cwd setup away will find
   * the refusal test silently stops testing anything, so the reason is executable, not a note.
   */
  it('DEMONSTRATES why the cwd must be clean: a .cortextos-env in cwd supplies identity', () => {
    writeFileSync(join(cleanCwd, '.cortextos-env'), 'CTX_AGENT_NAME=from-env-file\n');

    const r = runCli(['bus', 'annotate-task', taskId, 'note'], { cwd: cleanCwd });
    expect(r.status).toBe(0);
    expect(readTask().annotations?.[0].agent).toBe('from-env-file');
  });
});
