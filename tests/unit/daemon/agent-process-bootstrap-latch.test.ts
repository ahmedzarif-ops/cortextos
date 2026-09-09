import { describe, it, expect, vi } from 'vitest';
import { OutputBuffer } from '../../../src/pty/output-buffer.js';
import { AgentProcess } from '../../../src/daemon/agent-process.js';
import { FastChecker } from '../../../src/daemon/fast-checker.js';
import type { BusPaths, CtxEnv, AgentConfig } from '../../../src/types';

/**
 * THE LATENT SECOND SITE OF THE #32 DEFECT, CLOSED AT THE LAYER RATHER THAN THE CALL SITE.
 *
 * `AgentProcess` used to expose `isBootstrapped()`, delegating to
 * `OutputBuffer.isBootstrapped()` — a whole-window predicate over a RING THAT EVICTS. It
 * answers "is the bootstrap pattern on screen right now" and can go back to `false` after
 * having been `true`. Its ONE caller, `FastChecker.waitForBootstrap()`, asks the different,
 * monotonic question "did this session start".
 *
 * That was safe ONLY because of where the single caller sits (startup, buffer fresh, nothing
 * has evicted yet) — i.e. safe by accident of arithmetic, one new call site away from being a
 * live false negative. The fix removes the CLASS: the momentary predicate is no longer
 * reachable from `AgentProcess` at all, so a future caller cannot pick the wrong one.
 *
 * ⚠ WHAT EACH CONTROL PINS, STATED, so no sentence here outruns what is actually asserted:
 *   C1  — the latch survives eviction  (fails on the OLD code; this is the defining control)
 *   C1g — green companion: it is not a constant `true` before bootstrap
 *   C2  — the `?? false` arm when there is no PTY at all
 *   C3  — the SEAM: `waitForBootstrap` returns instead of burning its timeout, post-eviction
 *   C3g — green companion: `waitForBootstrap` DOES take the timeout path when nothing ever
 *         bootstrapped, so C3's assertion is proven able to fail
 *   C4  — the old NAME is gone from the class, so a re-add fails loud rather than silently
 *         re-opening the door
 * None of these pins the doc comments; those are held by review.
 */

const BOOTSTRAP = 'permissions\n> ';

/** A real OutputBuffer with a tiny ring, so eviction is REAL and not simulated by a mock. */
function bufferThatBootstrappedThenEvicted(): OutputBuffer {
  const buf = new OutputBuffer(4);
  buf.push(BOOTSTRAP);
  // Push strictly more than maxChunks so the bootstrap chunk is shifted out.
  for (let i = 0; i < 10; i++) buf.push(`ordinary output ${i}\n`);
  return buf;
}

function agentWithBuffer(buf: OutputBuffer | null): AgentProcess {
  const env = { instanceId: 'test', ctxRoot: '/tmp/test' } as unknown as CtxEnv;
  const agent = new AgentProcess('latch-agent', env, {} as AgentConfig, () => {});
  // Reach past `private pty` deliberately: this test is about the predicate the class
  // exposes, not about the spawn lifecycle, and driving a real PTY would test the host.
  (agent as unknown as { pty: unknown }).pty = buf === null
    ? null
    : { getOutputBuffer: () => buf };
  return agent;
}

function pathsIn(dir: string): BusPaths {
  return {
    ctxRoot: dir, stateDir: dir, inboxDir: dir, outboxDir: dir, processedDir: dir,
    inflightDir: dir, taskFile: dir, eventDir: dir, approvalDir: dir, analyticsDir: dir,
  } as unknown as BusPaths;
}

describe('AgentProcess bootstrap predicate is the LATCH, not the momentary window', () => {
  it('C1: reports bootstrapped after the evidence has been EVICTED from the ring', () => {
    const buf = bufferThatBootstrappedThenEvicted();

    // The premise of the whole test: eviction actually happened. Asserted, not assumed —
    // a control whose setup silently failed is indistinguishable from a passing one.
    expect(buf.isBootstrapped()).toBe(false);   // evidence gone from the window
    expect(buf.hasEverBootstrapped()).toBe(true); // event remembered

    expect(agentWithBuffer(buf).hasEverBootstrapped()).toBe(true);
  });

  it('C1g: reports NOT bootstrapped before any bootstrap output — not a constant true', () => {
    const buf = new OutputBuffer(4);
    buf.push('starting up\n');
    expect(agentWithBuffer(buf).hasEverBootstrapped()).toBe(false);
  });

  it('C2: reports NOT bootstrapped when there is no PTY at all', () => {
    expect(agentWithBuffer(null).hasEverBootstrapped()).toBe(false);
  });

  it('C4: the momentary name is GONE from AgentProcess, so a re-add fails loud', () => {
    const agent = agentWithBuffer(new OutputBuffer(4));
    expect(
      (agent as unknown as Record<string, unknown>).isBootstrapped,
      'AgentProcess.isBootstrapped() was re-added. It answers "is the pattern on screen NOW" '
      + 'over a ring that evicts; every caller at this layer wants "did this session start". '
      + 'Use hasEverBootstrapped(), or reach through getOutputBuffer()?.isBootstrapped() and '
      + 'say at the call site why the momentary answer is the one you want.',
    ).toBeUndefined();
  });
});

describe('FastChecker.waitForBootstrap — the seam, at the only call site', () => {
  it('C3: returns instead of burning the timeout when the buffer bootstrapped then evicted', async () => {
    // ⚠ FAKE TIMERS ON PURPOSE, and it is the difference between a kill and a coincidence.
    // With real timers this arm still goes red under the momentary predicate — but it goes
    // red by exceeding vitest's 10s testTimeout, i.e. the HOST rejects it, not the assertion
    // below. A test that reports which layer said no is testing the harness. Under fake
    // timers nothing advances the clock, so "returned without ever sleeping" becomes a
    // property this test can assert directly, and the failure names the real behaviour.
    vi.useFakeTimers();
    try {
      const logged: string[] = [];
      const agent = agentWithBuffer(bufferThatBootstrappedThenEvicted());
      const checker = new FastChecker(agent, pathsIn('/tmp'), '/tmp/framework', {
        log: (m: string) => logged.push(m),
      });

      let returned = false;
      const pending = (checker as unknown as { waitForBootstrap: (ms?: number) => Promise<void> })
        .waitForBootstrap(30000)
        .then(() => { returned = true; });

      // Flush microtasks WITHOUT advancing the clock. The loop's only wait is sleep(2000),
      // so returning here means the very first poll answered true.
      await vi.advanceTimersByTimeAsync(0);

      expect(returned).toBe(true);
      expect(logged.join('\n')).not.toContain('Bootstrap timeout');

      // Let the promise settle either way so a failure cannot leave one dangling.
      await vi.advanceTimersByTimeAsync(31000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('C3g: DOES take the timeout path when nothing ever bootstrapped', async () => {
    vi.useFakeTimers();
    try {
      const logged: string[] = [];
      const buf = new OutputBuffer(4);
      buf.push('no status bar here\n');
      const agent = agentWithBuffer(buf);
      const checker = new FastChecker(agent, pathsIn('/tmp'), '/tmp/framework', {
        log: (m: string) => logged.push(m),
      });

      const pending = (checker as unknown as { waitForBootstrap: (ms?: number) => Promise<void> })
        .waitForBootstrap(4000);
      await vi.advanceTimersByTimeAsync(10000);
      await pending;

      expect(logged.join('\n')).toContain('Bootstrap timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});
