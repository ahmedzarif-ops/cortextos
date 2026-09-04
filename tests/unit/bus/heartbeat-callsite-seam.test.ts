/**
 * THE CALL-SITE SEAM — src/cli/bus.ts:582.
 *
 * ⛔ WHY THIS FILE EXISTS, AND WHY THE THREE TESTS THAT CLAIM TO COVER IT DO NOT.
 * PR #10 extracted `buildHeartbeatOptions` with this justification: "the bug lived in the SEAM …
 * the wiring is now something an assertion can hold." Guard (kbbb6) tested that claim by execution
 * and refuted it: reverting the CALL SITE to the pre-fix inline object left
 *   - the three tests titled "buildHeartbeatOptions — THE SEAM" at 22/22 PASS, and
 *   - the WHOLE REPO (2190 tests, 143 files) with an IDENTICAL failure set — 0 new failures.
 * Because those tests call `buildHeartbeatOptions` DIRECTLY. Reverting the call site leaves the
 * function defined, exported, still green, and simply NO LONGER CALLED. It becomes dead code and
 * the suite cannot tell.
 *
 * ⇒ EXTRACTING A JOINT INTO A NAMED FUNCTION MOVES THE SEAM; IT DOES NOT CLOSE IT. The seam is now
 * "does the action call it", and only a test that DRIVES THE COMMANDER ACTION can hold that.
 *
 * THE ACCEPTANCE CRITERION THIS FILE IS WRITTEN AGAINST (chief/growth, verified: no test in the repo
 * executes the update-heartbeat handler — four files import src/cli/bus and all reach exported
 * symbols only): THIS TEST MUST FAIL WHEN THE CALL SITE STOPS CALLING buildHeartbeatOptions.
 * Testing the builder's output again would satisfy nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const updateHeartbeatSpy = vi.fn();

vi.mock('../../../src/bus/heartbeat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/bus/heartbeat.js')>();
  return { ...actual, updateHeartbeat: (...args: unknown[]) => updateHeartbeatSpy(...args) };
});
// logEvent runs straight after the call under test; stub it so a logging failure cannot be
// mistaken for a seam failure.
vi.mock('../../../src/bus/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/bus/events.js')>();
  return { ...actual, logEvent: vi.fn() };
});

let root: string;
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

beforeEach(() => {
  updateHeartbeatSpy.mockClear();
  root = mkdtempSync(join(tmpdir(), 'seam-'));
  const org = 'testorg';
  mkdirSync(join(root, 'orgs', org, 'agents', 'seat'), { recursive: true });
  // The org declares a NON-UTC timezone. That is the whole point: if the call site stops passing a
  // resolved timezone, the value the spy receives changes, and this test is the only thing that
  // looks at it.
  writeFileSync(
    join(root, 'orgs', org, 'context.json'),
    JSON.stringify({ timezone: 'America/Chicago', day_mode_start: '08:00', day_mode_end: '00:00' }),
  );
  setEnv('CTX_FRAMEWORK_ROOT', root);
  setEnv('CTX_ROOT', root);
  setEnv('CTX_ORG', org);
  setEnv('CTX_AGENT_NAME', 'seat');
  setEnv('CTX_INSTANCE_ID', 'default');
  // ⚠ CTX_AGENT_DIR AND CTX_PROJECT_ROOT MUST BE OVERRIDDEN TOO. resolveEnv has a sandbox-leak
  // guard that refuses to run when the agent dir is not under the framework root, and a test that
  // sets only CTX_FRAMEWORK_ROOT inherits the LIVE seat's dir from the parent shell and is refused.
  // The guard fired on the first run of this file and it was right to: without it the test would
  // have driven the handler against the real fleet's directories.
  setEnv('CTX_AGENT_DIR', join(root, 'orgs', org, 'agents', 'seat'));
  setEnv('CTX_PROJECT_ROOT', root);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('update-heartbeat CALL SITE (src/cli/bus.ts:582)', () => {
  it('the commander action actually calls updateHeartbeat', async () => {
    const { busCommand } = await import('../../../src/cli/bus.js');
    await busCommand.parseAsync(['update-heartbeat', 'working'], { from: 'user' });
    // CONTROL: if the action never ran, every assertion below would be vacuous and this file would
    // report clean over a handler it never reached — which is precisely the defect it exists for.
    expect(updateHeartbeatSpy, 'the update-heartbeat action did not reach updateHeartbeat at all')
      .toHaveBeenCalledTimes(1);
  });

  it('⛔ THE SEAM: it hands updateHeartbeat a RESOLVED timezone, not the raw flag', async () => {
    const { busCommand } = await import('../../../src/cli/bus.js');
    await busCommand.parseAsync(['update-heartbeat', 'working'], { from: 'user' });

    const options = updateHeartbeatSpy.mock.calls[0]?.[3] as Record<string, unknown> | undefined;
    expect(options, 'updateHeartbeat received no options object').toBeDefined();
    // NO --timezone FLAG WAS PASSED. Before PR #10 the call site forwarded `opts.timezone`
    // verbatim, so this was `undefined` and the mode fell back to UTC — five hours wrong, in the
    // permissive direction, on the rule ONE VOICE had to be hardened around.
    // A revert of the call site puts `undefined` back here and FAILS THIS ASSERTION. That is the
    // property the three builder tests cannot have.
    expect(options?.timezone, 'the call site passed the raw flag, not a resolved timezone')
      .toBe('America/Chicago');
  });

  it('an explicit --timezone still wins over the org default', async () => {
    const { busCommand } = await import('../../../src/cli/bus.js');
    await busCommand.parseAsync(
      ['update-heartbeat', 'working', '--timezone', 'Asia/Tokyo'], { from: 'user' },
    );
    const options = updateHeartbeatSpy.mock.calls[0]?.[3] as Record<string, unknown> | undefined;
    // The control for the assertion above: it proves the value is READ FROM THE CALL, not a
    // constant this test would see whatever the call site did.
    expect(options?.timezone).toBe('Asia/Tokyo');
  });
});
