import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// `notifyAgent` QUEUES two arms — a `.urgent-signal` file the daemon polls, and a bus
// message for persistence. The bus arm's failure used to be swallowed by a bare
// `catch {}`, so a notify whose persistent copy never landed was indistinguishable
// from one where both arms succeeded, and the CLI printed "Signal sent" either way.

const sendMessage = vi.hoisted(() => vi.fn());
vi.mock('../../../src/bus/message.js', () => ({ sendMessage }));

const { notifyAgent } = await import('../../../src/bus/agents');

function sandbox() {
  const ctxRoot = mkdtempSync(join(tmpdir(), 'notify-outcome-'));
  return { ctxRoot, signalPath: join(ctxRoot, 'state', 'target-seat', '.urgent-signal') };
}
const paths = {} as never;

describe('notifyAgent reports which arms actually landed', () => {
  it('reports busQueued=true when both arms succeed', () => {
    const { ctxRoot, signalPath } = sandbox();
    sendMessage.mockReset().mockImplementation(() => undefined);

    const out = notifyAgent(paths, 'orchestrator', 'target-seat', 'gate the release', ctxRoot);

    expect(out).toEqual({ signalWritten: true, busQueued: true });
    expect(existsSync(signalPath)).toBe(true);
    expect(readFileSync(signalPath, 'utf-8')).toContain('gate the release');
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('reports busQueued=false WITH the reason when the bus arm throws — and does not throw itself', () => {
    const { ctxRoot, signalPath } = sandbox();
    sendMessage.mockReset().mockImplementation(() => { throw new Error('outbox is read-only'); });

    const out = notifyAgent(paths, 'orchestrator', 'target-seat', 'gate the release', ctxRoot);

    expect(out.signalWritten).toBe(true);
    expect(out.busQueued).toBe(false);
    expect(out.busError).toContain('outbox is read-only');
    // The signal file remains the primary mechanism and must still be written.
    expect(existsSync(signalPath)).toBe(true);
    rmSync(ctxRoot, { recursive: true, force: true });
  });
});
