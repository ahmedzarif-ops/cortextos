import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { AgentProcess } from '../../../src/daemon/agent-process';
import type { BusPaths } from '../../../src/types';

// `.urgent-signal` used to be deleted BEFORE the injection was attempted, so a signal
// whose injection failed was lost permanently and silently — with no retry possible,
// because the only copy was already gone. An urgent signal is the message class where
// silent loss is least acceptable and it was the one class with no retry at all.
//
// The two failure codes must not be treated alike, and that distinction is the reason
// these tests use `injectMessageDetailed` rather than the boolean wrapper:
//   NOT_RUNNING — nothing was delivered, the condition is transient  => RETAIN and retry
//   DEDUPED     — this exact signal was already injected             => CONSUME
// Retaining a DEDUPED signal would retry forever, because every retry is by
// construction another duplicate.

type InjectResult = { ok: true } | { ok: false; code: 'NOT_RUNNING' | 'DEDUPED'; message: string };

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'urgent-signal-retry-'));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, signalPath: join(stateDir, '.urgent-signal') };
}

function makeChecker(stateDir: string, results: InjectResult[]) {
  const injected: string[] = [];
  const logs: string[] = [];
  let call = 0;
  const agent = {
    name: 'test-seat',
    injectMessageDetailed: (content: string): InjectResult => {
      injected.push(content);
      const r = results[Math.min(call, results.length - 1)];
      call += 1;
      return r;
    },
    injectMessage: () => true,
  } as unknown as AgentProcess;

  const paths = { stateDir } as unknown as BusPaths;
  const fc = new FastChecker(agent, paths, '/nonexistent-framework-root', {
    log: (m: string) => logs.push(m),
  });
  return { fc, injected, logs };
}

const OK: InjectResult = { ok: true };
const DOWN: InjectResult = { ok: false, code: 'NOT_RUNNING', message: 'agent "test-seat" is registered but not running (status: stopped)' };
const DUPE: InjectResult = { ok: false, code: 'DEDUPED', message: 'inject for "test-seat" deduped' };

afterEach(() => vi.restoreAllMocks());

describe('FastChecker urgent signal is not consumed unless it was injected', () => {
  it('RETAINS the signal when the agent is not running — the defect being fixed', () => {
    const { stateDir, signalPath, root } = sandbox();
    writeFileSync(signalPath, JSON.stringify({ from: 'orchestrator', message: 'URGENT: gate the release' }));
    const { fc, injected, logs } = makeChecker(stateDir, [DOWN]);

    (fc as unknown as { checkUrgentSignal(): void }).checkUrgentSignal();

    // THE ASSERTION THAT IS THE WHOLE FIX. Under the old code this file was gone.
    expect(existsSync(signalPath)).toBe(true);
    expect(readFileSync(signalPath, 'utf-8')).toContain('gate the release');
    expect(injected).toHaveLength(1);
    expect(logs.join('\n')).toContain('RETAINED for retry 1/10');
    rmSync(root, { recursive: true, force: true });
  });

  it('CONSUMES the signal once an injection succeeds, and stops retrying', () => {
    const { stateDir, signalPath, root } = sandbox();
    writeFileSync(signalPath, JSON.stringify({ from: 'orchestrator', message: 'wake up' }));
    // First poll fails, second succeeds: the retained signal is retried and then consumed.
    const { fc, injected } = makeChecker(stateDir, [DOWN, OK]);
    const call = () => (fc as unknown as { checkUrgentSignal(): void }).checkUrgentSignal();

    call();
    expect(existsSync(signalPath)).toBe(true);   // retained after the failure
    call();
    expect(existsSync(signalPath)).toBe(false);  // consumed after the success
    expect(injected).toHaveLength(2);            // and it really was retried

    call();                                       // no file, nothing more to do
    expect(injected).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });

  it('CONSUMES a DEDUPED signal — retaining it would retry a duplicate forever', () => {
    const { stateDir, signalPath, root } = sandbox();
    writeFileSync(signalPath, JSON.stringify({ from: 'orchestrator', message: 'already delivered' }));
    const { fc, logs } = makeChecker(stateDir, [DUPE]);

    (fc as unknown as { checkUrgentSignal(): void }).checkUrgentSignal();

    expect(existsSync(signalPath)).toBe(false);
    expect(logs.join('\n')).toContain('deduped');
    rmSync(root, { recursive: true, force: true });
  });

  it('gives up LOUDLY after the retry bound so a down agent cannot spin the loop forever', () => {
    const { stateDir, signalPath, root } = sandbox();
    writeFileSync(signalPath, JSON.stringify({ from: 'orchestrator', message: 'never deliverable' }));
    const { fc, logs } = makeChecker(stateDir, [DOWN]);
    const call = () => (fc as unknown as { checkUrgentSignal(): void }).checkUrgentSignal();

    for (let i = 0; i < 9; i += 1) call();
    // CONTROL: still retained at the boundary. Without this, a bound of 1 would pass too.
    expect(existsSync(signalPath)).toBe(true);

    call(); // the 10th attempt hits the bound
    expect(existsSync(signalPath)).toBe(false);
    const text = logs.join('\n');
    expect(text).toContain('DROPPED after 10 failed injection attempts');
    // Giving up must still name the payload — the defect being fixed was a loss that said nothing.
    expect(text).toContain('never deliverable');
    rmSync(root, { recursive: true, force: true });
  });

  it('CONSUMES an empty signal file instead of retrying a payload that can never be injected', () => {
    const { stateDir, signalPath, root } = sandbox();
    writeFileSync(signalPath, '   ');
    const { fc, injected } = makeChecker(stateDir, [OK]);

    (fc as unknown as { checkUrgentSignal(): void }).checkUrgentSignal();

    expect(existsSync(signalPath)).toBe(false);
    expect(injected).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });
  // The retry count used to be a bare counter on the checker, not keyed to anything.
  // `.urgent-signal` is a single-slot file, so a NEWER signal overwriting an
  // undeliverable one inherited the old count and could be dropped after a single
  // attempt of its own — the retention spent on a payload that was already gone.
  it('RESTARTS the count when a newer signal overwrites the one being retried', () => {
    const { stateDir, signalPath, root } = sandbox();
    writeFileSync(signalPath, JSON.stringify({ from: 'orchestrator', message: 'first payload' }));
    const { fc, logs } = makeChecker(stateDir, [DOWN]);
    const call = () => (fc as unknown as { checkUrgentSignal(): void }).checkUrgentSignal();

    for (let i = 0; i < 9; i += 1) call();
    expect(logs.join('\n')).toContain('RETAINED for retry 9/10');

    // A newer signal lands mid-retry, overwriting the old one.
    writeFileSync(signalPath, JSON.stringify({ from: 'orchestrator', message: 'second payload' }));
    call();

    // Under the defect this was attempt 10/10 and the NEW signal was dropped after
    // one attempt. It must be retained, counting from 1.
    expect(existsSync(signalPath)).toBe(true);
    expect(readFileSync(signalPath, 'utf-8')).toContain('second payload');
    const text = logs.join('\n');
    expect(text).toContain('RETAINED for retry 1/10');
    expect(text).not.toContain('DROPPED');
    rmSync(root, { recursive: true, force: true });
  });

  // CONTROL for the test above: without it, an implementation that reset the count on
  // EVERY poll would pass — and would retry a permanently-undeliverable signal forever,
  // which is the bound this class also has to keep.
  it('KEEPS the count when the signal is rewritten with identical content', () => {
    const { stateDir, signalPath, root } = sandbox();
    const payload = JSON.stringify({ from: 'orchestrator', message: 'never deliverable' });
    writeFileSync(signalPath, payload);
    const { fc, logs } = makeChecker(stateDir, [DOWN]);
    const call = () => (fc as unknown as { checkUrgentSignal(): void }).checkUrgentSignal();

    for (let i = 0; i < 9; i += 1) {
      writeFileSync(signalPath, payload); // rewritten every poll, same bytes
      call();
    }
    expect(existsSync(signalPath)).toBe(true);

    writeFileSync(signalPath, payload);
    call();
    expect(existsSync(signalPath)).toBe(false);
    expect(logs.join('\n')).toContain('DROPPED after 10 failed injection attempts');
    rmSync(root, { recursive: true, force: true });
  });
});
