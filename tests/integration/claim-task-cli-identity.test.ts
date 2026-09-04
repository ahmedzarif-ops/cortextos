/**
 * claim-task must not claim a task in the name of the current directory.
 *
 * Found while fixing the same defect in annotate-task (city, 2026-09-04; chief task
 * 59228135). `resolveEnv().agentName` falls back to `basename(process.cwd())`, so
 * `opts.agent || env.agentName` was never empty and the `if (!agent)` guard could not fire.
 *
 * WHY THIS ONE IS WORSE THAN A MIS-SIGNED NOTE. claim-task writes OWNERSHIP, and `claimTask`
 * refuses a claim when another agent already owns the task. A claim signed with a directory
 * name therefore does not merely mislabel — it hands the task to `Desktop` and then LOCKS THE
 * REAL AGENT OUT, through the mutual exclusion this command exists to provide. The lockout
 * surfaces as "already claimed by ...", which reads like the command working correctly.
 *
 * Driven through the real CLI from a CLEAN cwd, HOME redirected so the live store is
 * unreachable. Inside any agent directory a `.cortextos-env` supplies identity and the
 * refusal path never runs — the last test asserts that trap rather than describing it.
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
const CWD_MARKER = 'cwd-basename-must-never-claim';

let home: string;
let cleanCwd: string;
let paths: BusPaths;
let taskId: string;

function runCli(args: string[], opts: { agentName?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CTX_ORG: ORG, CTX_INSTANCE_ID: 'default' };
  delete env.CTX_AGENT_NAME;
  delete env.CTX_ROOT;
  delete env.CTX_AGENT_DIR;
  if (opts.agentName) env.CTX_AGENT_NAME = opts.agentName;
  return spawnSync(TSX, [ENTRY, ...args], { encoding: 'utf8', cwd: cleanCwd, env });
}

function readTask(): Task {
  return JSON.parse(readFileSync(findTaskFile(paths, taskId) as string, 'utf-8'));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claim-cli-home-'));
  cleanCwd = join(mkdtempSync(join(tmpdir(), 'claim-cli-')), CWD_MARKER);
  mkdirSync(cleanCwd, { recursive: true });
  const orgBase = join(home, '.cortextos', 'default', 'orgs', ORG);
  paths = { taskDir: join(orgBase, 'tasks'), eventDir: join(orgBase, 'events'), messageDir: join(orgBase, 'messages') } as BusPaths;
  taskId = createTask(paths, 'chief', ORG, 'a claimable task', { description: 'unclaimed' });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cleanCwd, { recursive: true, force: true });
});

describe('claim-task CLI identity', () => {
  it('REFUSES to claim with the cwd basename, and leaves the task unclaimed', () => {
    const r = runCli(['bus', 'claim-task', taskId]);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no agent identity/i);
    expect(r.stderr).toMatch(/--agent/);

    // The lockout is the real damage: the task must still be claimable afterwards.
    const after = readTask();
    expect(JSON.stringify(after)).not.toContain(CWD_MARKER);
    expect(after.status).not.toBe('in_progress');
  });

  it('POSITIVE CONTROL: --agent claims it, so the refusal is not blocking every claim', () => {
    const ok = runCli(['bus', 'claim-task', taskId, '--agent', 'city']);
    expect(ok.status).toBe(0);

    const after = readTask();
    expect(after.assigned_to).toBe('city');
    expect(after.status).toBe('in_progress');
  });

  it('CTX_AGENT_NAME still claims — the fix removes the cwd guess, not the env var', () => {
    const r = runCli(['bus', 'claim-task', taskId], { agentName: 'sentinel' });
    expect(r.status).toBe(0);
    expect(readTask().assigned_to).toBe('sentinel');
  });

  /**
   * THE LOCKOUT, DEMONSTRATED. This is what the defect actually cost: once a task is claimed
   * under the wrong name, the mutual exclusion turns against the rightful owner and the error
   * message reads like correct behaviour.
   */
  it('shows the lockout the defect caused: a claim under a wrong name blocks the real agent', () => {
    expect(runCli(['bus', 'claim-task', taskId, '--agent', CWD_MARKER]).status).toBe(0);

    const blocked = runCli(['bus', 'claim-task', taskId, '--agent', 'city']);
    expect(blocked.status).not.toBe(0);
    expect(readTask().assigned_to).toBe(CWD_MARKER);
  });

  it('DEMONSTRATES why the cwd must be clean: a .cortextos-env in cwd supplies identity', () => {
    writeFileSync(join(cleanCwd, '.cortextos-env'), 'CTX_AGENT_NAME=from-env-file\n');
    const r = runCli(['bus', 'claim-task', taskId]);
    expect(r.status).toBe(0);
    expect(readTask().assigned_to).toBe('from-env-file');
  });
});
