import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

// The hook self-invokes main() at import. Scrub every live-agent variable so the
// import is a hard no-op (no CTX_AGENT_NAME → main() returns before touching any
// real state dir), instead of classifying against this shell's real agent.
const SCRUBBED_ENV_KEYS = [
  'BOT_TOKEN',
  'CHAT_ID',
  'CTX_AGENT_DIR',
  'CTX_AGENT_NAME',
  'CTX_DAEMON_PID',
  'CTX_FRAMEWORK_ROOT',
  'CTX_INSTANCE_ID',
  'CTX_ORG',
  'CTX_ROOT',
] as const;
const inheritedEnv = new Map(SCRUBBED_ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of SCRUBBED_ENV_KEYS) delete process.env[key];

const {
  readMaxCrashesPerDay,
  notifyAgents,
  classifyFromMarkers,
  shouldSendTelegramForEndType,
  shouldRouteCrashToOrchestrator,
  shouldDeferRuntimeEndToDaemonManager,
} = await import('../../../src/hooks/hook-crash-alert');
import { clearEndMarkers } from '../../../src/bus/heartbeat';
import {
  DAEMON_LIFECYCLE_OWNER_MARKER,
  clearDaemonLifecycleOwnerMarker,
  readLifecycleNotificationsPreference,
  readTelegramPollingPreference,
  writeDaemonLifecycleOwnerMarker,
} from '../../../src/telegram/lifecycle';

afterAll(() => {
  for (const key of SCRUBBED_ENV_KEYS) {
    const value = inheritedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('readMaxCrashesPerDay', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when agentDir is undefined', () => {
    expect(readMaxCrashesPerDay(undefined)).toBeNull();
  });

  it('returns null when config.json is missing', () => {
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when config.json is malformed', () => {
    writeFileSync(join(tmp, 'config.json'), '{ not valid json', 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when max_crashes_per_day is missing', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ agent_name: 'x' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns the configured number when present', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 10 }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBe(10);
  });

  it('returns null when max_crashes_per_day is not a number', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 'ten' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });
});

describe('shouldSendTelegramForEndType', () => {
  it.each(['crash', 'daemon-crashed'])(
    'preserves configured Chief actionable %s alerts when routine lifecycle is disabled',
    (endType) => {
      expect(shouldSendTelegramForEndType(endType, 'chief', 'chief', false, true)).toBe(true);
    },
  );

  it.each([
    'planned-restart',
    'session-refresh',
    'user-restart',
    'user-disable',
    'user-stop',
    'daemon-stop',
    'rate-limited',
  ])('suppresses configured Chief routine %s output when lifecycle notifications are disabled', (endType) => {
    expect(shouldSendTelegramForEndType(endType, 'chief', 'chief', false, true)).toBe(false);
  });

  it.each(['planned-restart', 'rate-limited', 'crash'])(
    'never lets a specialist send %s directly',
    (endType) => {
      expect(shouldSendTelegramForEndType(endType, 'sentinel', 'chief', true, true)).toBe(false);
    },
  );

  it('fails closed without configured authority', () => {
    expect(shouldSendTelegramForEndType('crash', 'chief', null, true, true)).toBe(false);
  });

  it('allows configured Chief routine output when enabled or unset', () => {
    expect(shouldSendTelegramForEndType('planned-restart', 'chief', 'chief', true, true)).toBe(true);
    expect(shouldSendTelegramForEndType('planned-restart', 'chief', 'chief', undefined, undefined)).toBe(true);
  });
});

describe('shouldSendTelegramForEndType telegram_polling opt-out', () => {
  it.each(['crash', 'daemon-crashed', 'planned-restart', 'rate-limited'])(
    'suppresses every direct configured Chief %s send when telegram_polling is false',
    (endType) => {
      expect(shouldSendTelegramForEndType(endType, 'chief', 'chief', true, false)).toBe(false);
      expect(shouldSendTelegramForEndType(endType, 'chief', 'chief', undefined, false)).toBe(false);
    },
  );

  it('does not let telegram_polling grant authority to a specialist', () => {
    expect(shouldSendTelegramForEndType('crash', 'sentinel', 'chief', true, true)).toBe(false);
    expect(shouldSendTelegramForEndType('crash', 'sentinel', 'chief', true, false)).toBe(false);
  });
});

describe('shouldDeferRuntimeEndToDaemonManager (daemon-owner provenance)', () => {
  let tmp: string;
  const livePid = String(process.pid);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-daemon-owner-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it.each(['crash', 'rate-limited'])(
    'defers %s only when marker, injected env PID, and liveness all agree',
    (endType) => {
      writeDaemonLifecycleOwnerMarker(tmp, 'dev');
      expect(shouldDeferRuntimeEndToDaemonManager(endType, tmp, 'dev', livePid)).toBe(true);
    },
  );

  it.each(['planned-restart', 'daemon-crashed', 'user-stop', 'session-refresh'])(
    'never defers %s even with a live matching owner',
    (endType) => {
      writeDaemonLifecycleOwnerMarker(tmp, 'dev');
      expect(shouldDeferRuntimeEndToDaemonManager(endType, tmp, 'dev', livePid)).toBe(false);
    },
  );

  it.each([
    ['no injected PID (manual standalone session)', undefined],
    ['empty injected PID', ''],
    ['non-numeric injected PID', 'abc'],
    ['zero injected PID', '0'],
    ['negative injected PID', '-1'],
    ['padded injected PID', ` ${process.pid}`],
  ])('keeps standalone hook coverage with %s', (_label, envPid) => {
    writeDaemonLifecycleOwnerMarker(tmp, 'dev');
    expect(shouldDeferRuntimeEndToDaemonManager('crash', tmp, 'dev', envPid)).toBe(false);
  });

  it('does not defer when the injected PID is live but is not the PID that wrote the marker', () => {
    // Marker names a live process (this one); env claims a different live PID (our parent).
    writeDaemonLifecycleOwnerMarker(tmp, 'dev');
    expect(shouldDeferRuntimeEndToDaemonManager('crash', tmp, 'dev', String(process.ppid))).toBe(false);
  });

  it('does not defer when the marker belongs to another agent', () => {
    writeDaemonLifecycleOwnerMarker(tmp, 'other-agent');
    expect(shouldDeferRuntimeEndToDaemonManager('crash', tmp, 'dev', livePid)).toBe(false);
  });

  it('does not defer when the recorded daemon PID is dead even if env matches it', () => {
    const deadPid = 2147483000;
    writeFileSync(
      join(tmp, DAEMON_LIFECYCLE_OWNER_MARKER),
      JSON.stringify({ daemonPid: deadPid, agentName: 'dev' }),
      'utf-8',
    );
    expect(shouldDeferRuntimeEndToDaemonManager('crash', tmp, 'dev', String(deadPid))).toBe(false);
  });

  it.each([
    ['missing marker', null],
    ['malformed marker', '{not-json'],
    ['array marker', '[]'],
    ['string PID marker', JSON.stringify({ daemonPid: String(process.pid), agentName: 'dev' })],
  ])('does not defer with %s', (_label, content: string | null) => {
    if (content !== null) writeFileSync(join(tmp, DAEMON_LIFECYCLE_OWNER_MARKER), content, 'utf-8');
    expect(shouldDeferRuntimeEndToDaemonManager('crash', tmp, 'dev', livePid)).toBe(false);
  });

  it('stops deferring once the daemon clears its marker on stop', () => {
    writeDaemonLifecycleOwnerMarker(tmp, 'dev');
    expect(shouldDeferRuntimeEndToDaemonManager('crash', tmp, 'dev', livePid)).toBe(true);
    clearDaemonLifecycleOwnerMarker(tmp);
    expect(existsSync(join(tmp, DAEMON_LIFECYCLE_OWNER_MARKER))).toBe(false);
    expect(shouldDeferRuntimeEndToDaemonManager('crash', tmp, 'dev', livePid)).toBe(false);
  });
});

describe('readTelegramPollingPreference', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-polling-config-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it.each([[true, true], [false, false]])('reads exact boolean %s', (value, expected) => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ telegram_polling: value }));
    expect(readTelegramPollingPreference(tmp)).toBe(expected);
  });

  it.each([
    ['missing', null],
    ['malformed', '{not-json'],
    ['unset', JSON.stringify({})],
    ['string false', JSON.stringify({ telegram_polling: 'false' })],
  ])('returns undefined for %s configuration', (_label, content: string | null) => {
    if (content !== null) writeFileSync(join(tmp, 'config.json'), content);
    expect(readTelegramPollingPreference(tmp)).toBeUndefined();
  });
});

describe('shouldRouteCrashToOrchestrator', () => {
  it.each(['crash', 'daemon-crashed'])('routes specialist %s internally', (endType) => {
    expect(shouldRouteCrashToOrchestrator(endType, 'sentinel', 'chief')).toBe(true);
  });

  it.each(['planned-restart', 'rate-limited'])(
    'does not route routine %s as a crash escalation',
    (endType) => {
      expect(shouldRouteCrashToOrchestrator(endType, 'sentinel', 'chief')).toBe(false);
    },
  );

  it('does not self-route or route without authority', () => {
    expect(shouldRouteCrashToOrchestrator('crash', 'chief', 'chief')).toBe(false);
    expect(shouldRouteCrashToOrchestrator('crash', 'sentinel', null)).toBe(false);
  });
});

describe('readLifecycleNotificationsPreference', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-lifecycle-config-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it.each([
    [true, true],
    [false, false],
  ])('reads exact boolean %s', (value, expected) => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      telegram_lifecycle_notifications: value,
    }));
    expect(readLifecycleNotificationsPreference(tmp)).toBe(expected);
  });

  it.each([
    ['missing', null],
    ['malformed', '{not-json'],
    ['unset', JSON.stringify({})],
    ['non-boolean', JSON.stringify({ telegram_lifecycle_notifications: 'false' })],
  ])('returns undefined for %s configuration', (_label, content: string | null) => {
    if (content !== null) writeFileSync(join(tmp, 'config.json'), content);
    expect(readLifecycleNotificationsPreference(tmp)).toBeUndefined();
  });
});

describe('notifyAgents', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('sends one bus send-message per recipient', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'uncaught exception',
      lastTask: 'building hooks',
      crashCount: 2,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('uses cortextos bus send-message with priority high', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'r',
      lastTask: 't',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('cortextos');
    expect(args.slice(0, 4)).toEqual(['bus', 'send-message', 'chief', 'high']);
  });

  it('body includes all required fields', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'daemon-crashed',
      reason: 'PTY null write',
      lastTask: 'idle',
      crashCount: 3,
      restartAttempted: false,
      recipients: ['analyst'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('agent=dev');
    expect(body).toContain('type=daemon-crashed');
    expect(body).toContain('reason: PTY null write');
    expect(body).toContain('last status: idle');
    expect(body).toContain('crashes today: 3');
    expect(body).toContain('restart attempted: no');
  });

  it('marks restart attempted yes when crashCount under limit', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    expect(execFileMock.mock.calls[0][1][4]).toContain('restart attempted: yes');
  });

  it('uses fallback strings when reason and lastTask are empty', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('reason: none');
    expect(body).toContain('last status: unknown');
  });

  it('does not throw when execFile throws synchronously', () => {
    execFileMock.mockImplementationOnce(() => { throw new Error('exec failed'); });
    expect(() => notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    })).not.toThrow();
    // Second recipient still attempted
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('classifyFromMarkers', () => {
  let tmp: string;
  const MARKERS = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-stop', type: 'user-stop' },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-markers-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('no marker present → endType crash', () => {
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('crash');
  });

  it('fresh marker → classified by type, with its reason', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned reboot', 'utf-8');
    const r = classifyFromMarkers(tmp, MARKERS);
    expect(r.endType).toBe('planned-restart');
    expect(r.reason).toBe('planned reboot');
  });

  it('does NOT consume the marker — both firings of a restart see it', () => {
    writeFileSync(join(tmp, '.session-refresh'), 'rollover', 'utf-8');
    // Firing #1 — the dying PTY's SessionEnd.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh');
    // Firing #2 — the next PTY's fresh-launch cleanup. Marker must still be
    // there: this is the FP that the old unlink-on-read code produced.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh');
    expect(existsSync(join(tmp, '.session-refresh'))).toBe(true);
  });

  it('marker older than the TTL → treated as stale: ignored AND lazy-unlinked', () => {
    const markerPath = join(tmp, '.restart-planned');
    writeFileSync(markerPath, 'stale planned restart', 'utf-8');
    // Simulate a marker whose first-heartbeat clear never fired (failed
    // start): classify with a "now" well past the 5-minute TTL.
    const farFuture = Date.now() + 10 * 60 * 1000;
    const r = classifyFromMarkers(tmp, MARKERS, farFuture);
    expect(r.endType).toBe('crash'); // stale marker must NOT mask a real crash
    expect(existsSync(markerPath)).toBe(false); // lazy-unlinked
  });

  it('first matching marker wins (precedence order preserved)', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned', 'utf-8');
    writeFileSync(join(tmp, '.user-stop'), 'stopped', 'utf-8');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
  });
});

describe('clearEndMarkers (via heartbeat)', () => {
  let tmp: string;
  const ALL = ['.restart-planned', '.session-refresh', '.user-restart', '.user-stop', '.daemon-stop'];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-clear-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a post-grace heartbeat removes every pending end-type marker', () => {
    for (const f of ALL) writeFileSync(join(tmp, f), 'x', 'utf-8');
    // nowMs well past the grace window — the markers are no longer in-flight.
    clearEndMarkers(tmp, Date.now() + 10 * 60 * 1000);
    for (const f of ALL) expect(existsSync(join(tmp, f))).toBe(false);
  });

  it('leaves a fresh (within-grace) marker in place — an in-flight restart', () => {
    for (const f of ALL) writeFileSync(join(tmp, f), 'x', 'utf-8');
    // nowMs ≈ marker mtime → every marker is within the grace window.
    clearEndMarkers(tmp);
    for (const f of ALL) expect(existsSync(join(tmp, f))).toBe(true);
  });

  it('is a no-op when no markers are present', () => {
    expect(() => clearEndMarkers(tmp)).not.toThrow();
  });
});

describe('marker lifecycle (classify → clearEndMarkers → classify)', () => {
  let tmp: string;
  const MARKERS = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-stop', type: 'user-stop' },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-lifecycle-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('both restart firings classify, a post-grace heartbeat clears, then a real crash classifies as crash', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned reboot', 'utf-8');
    // Firing #1 and #2 of the dying restart — both must see the marker.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
    // Post-restart session heartbeats past the grace window → marker cleared.
    clearEndMarkers(tmp, Date.now() + 10 * 60 * 1000);
    expect(existsSync(join(tmp, '.restart-planned'))).toBe(false);
    // A genuine crash AFTER the clear must classify as crash — not be masked.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('crash');
  });

  it('a heartbeat DURING the in-flight restart (within grace) does NOT wipe the marker — firing#2 still classifies', () => {
    // This is the Finding-1 race: a fast-booting successor heartbeats before
    // the dying restart's second SessionEnd firing lands.
    writeFileSync(join(tmp, '.session-refresh'), 'rollover', 'utf-8');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh'); // firing #1
    clearEndMarkers(tmp); // successor's first heartbeat — marker still within grace
    expect(existsSync(join(tmp, '.session-refresh'))).toBe(true);
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh'); // firing #2 — no false crash
  });
});
