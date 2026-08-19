import { describe, expect, it, vi } from 'vitest';
import { verifyPtySpawn } from '../../../src/platform/pty-smoke';

describe('PTY smoke cleanup', () => {
  it('disposes ConPTY subscriptions after a successful command', async () => {
    const disposeData = vi.fn();
    const disposeExit = vi.fn();
    const fakePty = {
      kill: vi.fn(),
      onData(callback: (data: string) => void) {
        queueMicrotask(() => callback('pty-ok\r\n'));
        return { dispose: disposeData };
      },
      onExit(callback: (event: { exitCode: number }) => void) {
        queueMicrotask(() => callback({ exitCode: 0 }));
        return { dispose: disposeExit };
      },
    };

    await verifyPtySpawn({ spawn: () => fakePty }, 'win32', 100);

    expect(disposeData).toHaveBeenCalledOnce();
    expect(disposeExit).toHaveBeenCalledOnce();
    expect(fakePty.kill).not.toHaveBeenCalled();
  });

  it('kills and disposes a timed-out PTY', async () => {
    const disposeData = vi.fn();
    const disposeExit = vi.fn();
    const fakePty = {
      kill: vi.fn(),
      onData: () => ({ dispose: disposeData }),
      onExit: () => ({ dispose: disposeExit }),
    };

    await expect(verifyPtySpawn({ spawn: () => fakePty }, 'win32', 5))
      .rejects.toThrow('timed out');
    expect(fakePty.kill).toHaveBeenCalledOnce();
    expect(disposeData).toHaveBeenCalledOnce();
    expect(disposeExit).toHaveBeenCalledOnce();
  });
});
