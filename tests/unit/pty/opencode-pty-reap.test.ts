import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OpencodePTY } from '../../../src/pty/opencode-pty.js';

// Face #2 — confirm-dead reap. These tests exercise the REAL kill path against
// REAL OS processes and a REAL marker file (no process.kill mocks), because the
// whole point of the fix is to prove the orphan is actually gone, not merely
// that a signal was sent. cleanupStaleProcessMarker() is driven directly so no
// `opencode` binary is spawned.

const AGENT = 'opencode-agent';
let ctxRoot: string;
const children: ChildProcess[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function stateDir(): string { return join(ctxRoot, 'state', AGENT); }
function markerPath(): string { return join(stateDir(), 'opencode-process.json'); }

async function spawnLongLived(ignoreSigterm = false): Promise<ChildProcess> {
  const signalHandler = ignoreSigterm ? 'process.on("SIGTERM", () => {});' : '';
  const child = spawn(
    process.execPath,
    ['-e', `${signalHandler} setInterval(() => {}, 1e9);`],
    { stdio: 'ignore' },
  );
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  children.push(child);
  return child;
}

function forceKillTestChild(child: ChildProcess): void {
  if (!child.pid || !isAlive(child.pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
}

function writeProcessMarker(pid: number): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(
    markerPath(),
    JSON.stringify({ runtime: 'opencode', pid, updated_at: new Date().toISOString() }),
    'utf-8',
  );
}

function makePty(): OpencodePTY {
  const env = {
    instanceId: 'test',
    ctxRoot,
    frameworkRoot: join(ctxRoot, 'fw'),
    agentName: AGENT,
    agentDir: join(ctxRoot, 'fw', 'agents', AGENT),
    org: 'acme',
    projectRoot: join(ctxRoot, 'fw'),
  };
  return new OpencodePTY(env, {}, join(ctxRoot, 'logs', AGENT, 'stdout.log'));
}

/** Wait until a pid is dead or the timeout elapses. */
async function waitDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'oc-reap-'));
});

afterEach(() => {
  for (const c of children) {
    forceKillTestChild(c);
  }
  children.length = 0;
  try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('OpencodePTY.cleanupStaleProcessMarker confirm-dead reap', () => {
  it('SIGTERMs a stale process, confirms it is dead, and removes the marker', async () => {
    // A plain Node child dies on SIGTERM (default disposition) and is available
    // on every supported host without relying on a Unix `sleep` executable.
    const child = await spawnLongLived();
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);
    writeProcessMarker(pid);

    const pty = makePty();
    await (pty as unknown as { cleanupStaleProcessMarker(): Promise<void> }).cleanupStaleProcessMarker();

    // Reaped for real: the process is gone and the marker is unlinked.
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(markerPath())).toBe(false);
  });

  it('escalates to SIGKILL when a stale process ignores SIGTERM', async () => {
    // This child installs a no-op SIGTERM handler, so only SIGKILL can end it —
    // proving the escalation path actually confirms death rather than giving up
    // after the ignored SIGTERM.
    const child = await spawnLongLived(true);
    const pid = child.pid!;
    // Give node a moment to install the handler before we reap.
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(pid)).toBe(true);
    writeProcessMarker(pid);

    const pty = makePty();
    await (pty as unknown as { cleanupStaleProcessMarker(): Promise<void> }).cleanupStaleProcessMarker();

    expect(await waitDead(pid)).toBe(true);
    expect(existsSync(markerPath())).toBe(false);
  }, 10000);

  it('removes a marker for an already-dead pid without error', async () => {
    const child = await spawnLongLived();
    const pid = child.pid!;
    forceKillTestChild(child);
    expect(await waitDead(pid)).toBe(true);
    writeProcessMarker(pid);

    const pty = makePty();
    await (pty as unknown as { cleanupStaleProcessMarker(): Promise<void> }).cleanupStaleProcessMarker();

    expect(existsSync(markerPath())).toBe(false);
  });
});
