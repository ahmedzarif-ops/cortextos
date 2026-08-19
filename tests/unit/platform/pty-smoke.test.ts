import { describe, expect, it, vi } from 'vitest';
import { verifyPtySpawn, type SmokeChildProcess } from '../../../src/platform/pty-smoke';

function fakeChild(): {
  child: SmokeChildProcess;
  emitExit: (code: number | null) => void;
  emitError: (error: Error) => void;
  kill: ReturnType<typeof vi.fn>;
} {
  let exitListener: ((code: number | null) => void) | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  const kill = vi.fn(() => true);
  const child = {
    kill,
    once(event: 'error' | 'exit', listener: ((value: Error) => void) | ((value: number | null) => void)) {
      if (event === 'error') errorListener = listener as (error: Error) => void;
      else exitListener = listener as (code: number | null) => void;
      return this;
    },
  };
  return {
    child,
    emitExit: (code) => exitListener?.(code),
    emitError: (error) => errorListener?.(error),
    kill,
  };
}

describe('PTY smoke process isolation', () => {
  it('resolves when the isolated native probe exits successfully', async () => {
    const fake = fakeChild();
    const spawn = vi.fn(() => fake.child);
    const result = verifyPtySpawn(100, spawn);
    fake.emitExit(0);

    await expect(result).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][0]).toBe(process.execPath);
    expect(spawn.mock.calls[0][1][0]).toBe('-e');
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it('rejects a failed isolated probe', async () => {
    const fake = fakeChild();
    const result = verifyPtySpawn(100, () => fake.child);
    fake.emitExit(1);

    await expect(result).rejects.toThrow('spawn test failed (exit 1)');
  });

  it('kills and rejects a timed-out isolated probe', async () => {
    const fake = fakeChild();
    const result = verifyPtySpawn(5, () => fake.child);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.kill).toHaveBeenCalledOnce();
    fake.emitExit(null);

    await expect(result).rejects.toThrow('timed out');
  });
});
