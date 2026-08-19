import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { spawnHeadlessProcess } = await import('../../../src/platform/headless-process.js');

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe('headless native process adapter', () => {
  beforeEach(() => spawnMock.mockReset());

  it('launches without a shell or terminal and combines protocol diagnostics', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const processHandle = spawnHeadlessProcess('codex.exe', ['app-server'], {
      cwd: 'C:\\work',
      env: { SystemRoot: 'C:\\Windows' },
    });
    const output: string[] = [];
    processHandle.onData((data) => output.push(data));

    child.stdout.write('listening ');
    child.stderr.write('on loopback');

    expect(spawnMock).toHaveBeenCalledWith('codex.exe', ['app-server'], {
      cwd: 'C:\\work',
      env: { SystemRoot: 'C:\\Windows' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(processHandle.pid).toBe(4242);
    expect(output.join('')).toBe('listening on loopback');
  });

  it('reports spawn errors once and supports bounded cleanup', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const processHandle = spawnHeadlessProcess('codex.exe', [], {});
    const exits = vi.fn();
    processHandle.onExit(exits);

    child.emit('error', new Error('ENOENT'));
    child.emit('exit', 1, null);
    processHandle.kill();

    expect(exits).toHaveBeenCalledOnce();
    expect(exits).toHaveBeenCalledWith({ exitCode: 1 });
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
