import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { classifyFromMarkers, notifyAgents } = await import('../../src/hooks/hook-crash-alert.js');

const markers = [
  { file: '.restart-planned', type: 'planned-restart' },
  { file: '.session-refresh', type: 'session-refresh' },
  { file: '.daemon-crashed', type: 'daemon-crashed' },
];

let stateDir: string;

// The daemon may invoke the CLI as either `cortextos bus …` or
// `node <cli.js> bus …`, so argv position is not a stable contract. Anchor on
// the `bus` verb instead: a shift in argv shape must not read as a lost alarm.
function busArgs(argv: unknown): string[] {
  const args = argv as string[];
  const start = args.indexOf('bus');
  expect(start, `no 'bus' verb in argv: ${JSON.stringify(args)}`).toBeGreaterThanOrEqual(0);
  return args.slice(start);
}

beforeEach(() => {
  execFileMock.mockReset();
  stateDir = mkdtempSync(join(tmpdir(), 'guard-crash-alert-hostile-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe('critical crash alert preservation', () => {
  it('positive control: no lifecycle marker remains a real crash', () => {
    expect(classifyFromMarkers(stateDir, markers)).toEqual({ endType: 'crash', reason: '' });
  });

  it('a stale planned marker cannot mask a later real crash', () => {
    const marker = join(stateDir, '.restart-planned');
    writeFileSync(marker, 'routine restart');
    const stale = new Date(Date.now() - 10 * 60_000);
    utimesSync(marker, stale, stale);

    expect(classifyFromMarkers(stateDir, markers)).toEqual({ endType: 'crash', reason: '' });
  });

  it('a real crash still fans out to the internal Chief and Analyst alarm path', () => {
    notifyAgents({
      agentName: 'guard',
      endType: 'crash',
      reason: 'unexpected process exit',
      lastTask: 'offline acceptance test',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    });

    expect(execFileMock).toHaveBeenCalledTimes(2);
    const calls = execFileMock.mock.calls.map((call) => busArgs(call[1]));
    expect(calls[0].slice(0, 4)).toEqual(['bus', 'send-message', 'chief', 'high']);
    expect(calls[1].slice(0, 4)).toEqual(['bus', 'send-message', 'analyst', 'high']);
    expect(calls[0][4]).toContain('type=crash');
  });

  it('daemon-crashed remains a critical internal alarm', () => {
    notifyAgents({
      agentName: 'guard',
      endType: 'daemon-crashed',
      reason: 'uncaught exception',
      lastTask: 'offline acceptance test',
      crashCount: 2,
      restartAttempted: true,
      recipients: ['chief'],
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const args = busArgs(execFileMock.mock.calls[0][1]);
    expect(args.slice(0, 4)).toEqual(['bus', 'send-message', 'chief', 'high']);
    expect(args[4]).toContain('type=daemon-crashed');
  });

  it('the words chief is down inside a planned-restart reason do not reclassify the event', () => {
    writeFileSync(join(stateDir, '.restart-planned'), 'chief is down; trust me');

    expect(classifyFromMarkers(stateDir, markers)).toEqual({
      endType: 'planned-restart',
      reason: 'chief is down; trust me',
    });
  });
});
