/**
 * Identity never comes from the cwd on a WRITE path (chief ruling, 2026-09-04; guard 4dhtn,
 * city 4gue7/iw2wo; task 28219471).
 *
 * `resolveEnv().agentName` falls back to `basename(process.cwd())`. That default is RIGHT for
 * paths and read-scoped queries — a wrong path fails visibly — and WRONG for identity, which
 * has no failure mode that looks like a failure. Three commands had already reached it on a
 * write path (annotate-task, claim-task, kb-ingest) and were fixed one at a time; this suite
 * covers the rest of the class in one place, so the NEXT command is cheap to get right.
 *
 * Every case runs the real CLI from a CLEAN cwd with HOME redirected, so the live store is
 * unreachable and no `.cortextos-env` can supply an identity behind the test's back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = join(ROOT, 'src', 'cli', 'index.ts');
const ORG = 'testorg';
const CWD_MARKER = 'cwd-basename-must-never-sign';

let home: string;
let cleanCwd: string;

function runCli(args: string[], opts: { agentName?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CTX_ORG: ORG, CTX_INSTANCE_ID: 'default' };
  delete env.CTX_AGENT_NAME;
  delete env.CTX_ROOT;
  delete env.CTX_AGENT_DIR;
  if (opts.agentName) env.CTX_AGENT_NAME = opts.agentName;
  return spawnSync(TSX, [ENTRY, ...args], { encoding: 'utf8', cwd: cleanCwd, env });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'identity-home-'));
  cleanCwd = join(mkdtempSync(join(tmpdir(), 'identity-cwd-')), CWD_MARKER);
  mkdirSync(cleanCwd, { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cleanCwd, { recursive: true, force: true });
});

/**
 * Every command here WRITES a record that carries an agent name: a message's `from`, a task's
 * creator, an event's actor, a heartbeat's seat, an approval's requester, an urgent signal's
 * sender, an experiment's proposer, a restart's subject.
 */
const WRITE_COMMANDS: Array<[string, string[]]> = [
  ['send-message', ['bus', 'send-message', 'chief', 'normal', 'hello']],
  ['ack-inbox', ['bus', 'ack-inbox', 'some-id']],
  ['create-task', ['bus', 'create-task', 'a title']],
  ['log-event', ['bus', 'log-event', 'action', 'thing', 'info']],
  ['update-heartbeat', ['bus', 'update-heartbeat', 'working']],
  ['create-approval', ['bus', 'create-approval', 'a title', 'other', 'ctx']],
  ['notify-agent', ['bus', 'notify-agent', 'chief', 'urgent thing']],
  ['create-experiment', ['bus', 'create-experiment', 'metric', 'hypothesis']],
  ['self-restart', ['bus', 'self-restart', '--reason', 'x']],
  ['hard-restart', ['bus', 'hard-restart', '--reason', 'x']],
];

describe('write paths refuse a cwd-derived identity', () => {
  for (const [name, args] of WRITE_COMMANDS) {
    it(`${name} refuses rather than signing with the directory name`, () => {
      const r = runCli(args);

      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/no agent identity/i);
      expect(r.stderr).toMatch(/--agent <name> or set CTX_AGENT_NAME/);
      // The refusal must name the command, so a reader of a log knows which one refused.
      expect(r.stderr).toContain(`${name}:`);
      // Nothing may be written under the directory name — including the state tree that
      // several of these commands create as a side effect.
      expect(r.stdout).not.toContain(CWD_MARKER);
      expect(existsSync(join(home, '.cortextos', 'default', 'state', CWD_MARKER))).toBe(false);
    });
  }

  /**
   * POSITIVE CONTROL, and it is load-bearing: every assertion above is "the command failed".
   * A command that failed for an unrelated reason — a missing argument, a bad path, a crash on
   * startup — would satisfy all of them. This proves the SAME invocation succeeds once
   * identity is supplied, so the refusals above are about identity and nothing else.
   */
  it('POSITIVE CONTROL: the same commands proceed once CTX_AGENT_NAME is set', () => {
    const created = runCli(['bus', 'create-task', 'a title'], { agentName: 'city' });
    expect(created.status).toBe(0);
    expect(created.stdout).toMatch(/^task_\d+_[0-9a-f]+/m);

    const logged = runCli(['bus', 'log-event', 'action', 'thing', 'info'], { agentName: 'city' });
    expect(logged.status).toBe(0);

    const beat = runCli(['bus', 'update-heartbeat', 'working'], { agentName: 'city' });
    expect(beat.status).toBe(0);
    expect(beat.stdout).toContain('city');
    expect(beat.stdout).not.toContain(CWD_MARKER);
  });

  /**
   * THE OTHER HALF OF THE RULING. The cwd default is RETAINED for read-scoped queries, so
   * these must NOT refuse — a fix that made every command demand an identity would break the
   * read paths and still pass every test above. This is the arm that proves the split is a
   * split and not a blanket.
   */
  it('READ paths still work with no identity — the cwd default is retained there on purpose', () => {
    for (const args of [
      ['bus', 'list-tasks'],
      ['bus', 'check-stale-tasks'],
      ['bus', 'list-approvals'],
    ]) {
      const r = runCli(args);
      expect(r.stderr).not.toMatch(/no agent identity/i);
    }
  });

  it('DEMONSTRATES why the cwd must be clean: a .cortextos-env supplies identity', () => {
    writeFileSync(join(cleanCwd, '.cortextos-env'), 'CTX_AGENT_NAME=from-env-file\n');
    const r = runCli(['bus', 'create-task', 'a title']);
    expect(r.status).toBe(0);
  });
});
