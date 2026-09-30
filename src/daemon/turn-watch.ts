/**
 * Turn watch — tells "alive" apart from "alive but not answering".
 *
 * ⛔ WHY THIS EXISTS. A seat can hold a live process, a fresh heartbeat and an
 * empty inbox while doing nothing at all: the daemon injected a message, the
 * injection was accepted (inbox acked, "Injected N bytes" logged), and no turn
 * ever followed. Every liveness signal stays green, because none of them
 * measures whether the model is taking turns, so the state lasts until a human
 * happens to notice it.
 *
 * The turn signal is activity AFTER the injection, from either of:
 *   - the session transcript, whose path the statusLine hook records in
 *     context_status.json (plus the newest subagent transcript beside it, so a
 *     long foreground subagent does not read as a stall);
 *   - last_idle.flag, written when a turn ends (Stop hook; codex app-server).
 *
 * A seat with NEITHER source is reported UNKNOWN, never OK: a detector that has
 * nothing to read must say so, or it is indistinguishable from one that read
 * a healthy seat.
 *
 * This module only measures. It never restarts anything.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';

/**
 * How long an injection may go without any turn activity before the seat is
 * STALLED. Longer than the longest single foreground tool call (10 min), so a
 * seat mid-command when a message lands is not flagged.
 */
export const TURN_STALL_MS = 12 * 60_000;

export type TurnWatchState = 'idle' | 'waiting' | 'turned' | 'stalled' | 'unknown';

export interface TurnEvidence {
  /** Latest turn activity seen, epoch ms, or null when no source produced a reading. */
  at: number | null;
  /** Sources that produced a reading. Empty means there is nothing to measure. */
  sources: string[];
}

function newestJsonlMtime(dir: string): number | null {
  let newest: number | null = null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch { /* vanished between readdir and stat */ }
  }
  return newest;
}

/** Read every available turn signal for a seat. Never throws. */
export function readTurnEvidence(stateDir: string): TurnEvidence {
  const sources: string[] = [];
  let at: number | null = null;
  const seen = (source: string, ms: number) => {
    sources.push(source);
    if (at === null || ms > at) at = ms;
  };

  let transcript: string | null = null;
  try {
    const status = JSON.parse(readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
    if (typeof status.transcript_path === 'string' && status.transcript_path) {
      transcript = status.transcript_path;
    }
  } catch { /* no status file, or unparseable */ }

  if (transcript) {
    try {
      seen('transcript', statSync(transcript).mtimeMs);
    } catch { /* recorded path no longer exists */ }
    const subagents = join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents');
    const sub = newestJsonlMtime(subagents);
    if (sub !== null) seen('subagent_transcript', sub);
  }

  try {
    const secs = parseInt(readFileSync(join(stateDir, 'last_idle.flag'), 'utf-8').trim(), 10);
    if (Number.isFinite(secs)) seen('idle_flag', secs * 1000);
  } catch { /* no idle flag */ }

  return { at, sources };
}

/**
 * Classify a seat given the time of the oldest unanswered injection (0 = none).
 *
 * The caller must keep the OLDEST unanswered injection time, not the latest:
 * resetting the clock on every new injection would let steady traffic hide a
 * stall forever.
 */
export function evaluateTurnWatch(
  injectedAt: number,
  evidence: TurnEvidence,
  now: number,
  stallMs: number = TURN_STALL_MS,
): TurnWatchState {
  if (injectedAt === 0) return 'idle';
  if (evidence.at !== null && evidence.at >= injectedAt) return 'turned';
  if (now - injectedAt < stallMs) return 'waiting';
  return evidence.sources.length === 0 ? 'unknown' : 'stalled';
}
