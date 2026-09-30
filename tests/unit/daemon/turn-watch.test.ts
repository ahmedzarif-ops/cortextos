import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { evaluateTurnWatch, readTurnEvidence, TURN_STALL_MS } from '../../../src/daemon/turn-watch';

/**
 * The turn watch separates "alive" from "alive but not answering". These tests pin
 * the two halves separately: what counts as evidence of a turn, and how an
 * injection time plus that evidence is classified.
 *
 * ⭐ The UNKNOWN arm matters as much as the STALLED one: a seat with no turn signal
 * must never classify as healthy, or a detector with nothing to read is
 * indistinguishable from one that read a working seat.
 */

const T0 = Date.parse('2026-01-01T00:00:00Z');

function touch(path: string, ms: number): void {
  writeFileSync(path, '{}\n');
  utimesSync(path, ms / 1000, ms / 1000);
}

describe('readTurnEvidence', () => {
  let dir: string;
  let stateDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-watch-'));
    stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeStatus = (transcript: string | null) =>
    writeFileSync(join(stateDir, 'context_status.json'), JSON.stringify({ used_percentage: 5, transcript_path: transcript }));

  it('no sources at all yields no reading and no sources', () => {
    expect(readTurnEvidence(stateDir)).toEqual({ at: null, sources: [] });
  });

  it('a status file without transcript_path is not a source', () => {
    writeStatus(null);
    expect(readTurnEvidence(stateDir)).toEqual({ at: null, sources: [] });
  });

  it('a recorded transcript path that no longer exists is not a source', () => {
    writeStatus(join(dir, 'gone.jsonl'));
    expect(readTurnEvidence(stateDir)).toEqual({ at: null, sources: [] });
  });

  it('reads the transcript mtime', () => {
    const transcript = join(dir, 'session.jsonl');
    touch(transcript, T0 + 5_000);
    writeStatus(transcript);
    expect(readTurnEvidence(stateDir)).toEqual({ at: T0 + 5_000, sources: ['transcript'] });
  });

  it('a newer subagent transcript beside the session counts, and only .jsonl files do', () => {
    const transcript = join(dir, 'session.jsonl');
    touch(transcript, T0);
    const sub = join(dir, 'session', 'subagents');
    mkdirSync(sub, { recursive: true });
    touch(join(sub, 'agent-a.jsonl'), T0 + 60_000);
    touch(join(sub, 'agent-b.jsonl'), T0 + 30_000);
    touch(join(sub, 'agent-a.meta.json'), T0 + 900_000);
    writeStatus(transcript);
    expect(readTurnEvidence(stateDir)).toEqual({ at: T0 + 60_000, sources: ['transcript', 'subagent_transcript'] });
  });

  it('reads last_idle.flag as epoch seconds and takes the latest of all sources', () => {
    const transcript = join(dir, 'session.jsonl');
    touch(transcript, T0);
    writeStatus(transcript);
    writeFileSync(join(stateDir, 'last_idle.flag'), String((T0 + 120_000) / 1000));
    expect(readTurnEvidence(stateDir)).toEqual({ at: T0 + 120_000, sources: ['transcript', 'idle_flag'] });
  });

  it('an unparseable idle flag is not a source', () => {
    writeFileSync(join(stateDir, 'last_idle.flag'), 'garbage');
    expect(readTurnEvidence(stateDir)).toEqual({ at: null, sources: [] });
  });
});

describe('evaluateTurnWatch', () => {
  const withSource = (at: number | null) => ({ at, sources: ['transcript'] });

  it('nothing pending is idle', () => {
    expect(evaluateTurnWatch(0, withSource(null), T0)).toBe('idle');
  });

  it('activity at or after the injection is a turn', () => {
    expect(evaluateTurnWatch(T0, withSource(T0), T0 + TURN_STALL_MS * 2)).toBe('turned');
    expect(evaluateTurnWatch(T0, withSource(T0 + 1), T0 + TURN_STALL_MS * 2)).toBe('turned');
  });

  it('activity only BEFORE the injection is not a turn', () => {
    expect(evaluateTurnWatch(T0, withSource(T0 - 1), T0 + TURN_STALL_MS)).toBe('stalled');
  });

  it('waits until the threshold, then stalls — boundary pinned on both sides', () => {
    expect(evaluateTurnWatch(T0, withSource(T0 - 1), T0 + TURN_STALL_MS - 1)).toBe('waiting');
    expect(evaluateTurnWatch(T0, withSource(T0 - 1), T0 + TURN_STALL_MS)).toBe('stalled');
  });

  it('THE UNKNOWN ARM: past the threshold with no source is unknown, never stalled or ok', () => {
    expect(evaluateTurnWatch(T0, { at: null, sources: [] }, T0 + TURN_STALL_MS)).toBe('unknown');
    expect(evaluateTurnWatch(T0, { at: null, sources: [] }, T0 + TURN_STALL_MS - 1)).toBe('waiting');
  });

  it('honours a custom threshold', () => {
    expect(evaluateTurnWatch(T0, withSource(null), T0 + 1_000, 1_000)).toBe('stalled');
  });

  it('the default threshold outlasts the longest foreground tool call (10 min)', () => {
    expect(TURN_STALL_MS).toBeGreaterThan(10 * 60_000);
  });
});
