/**
 * Session continuity — decides when a restart must NOT reopen the previous
 * conversation.
 *
 * ⛔ WHY THIS EXISTS. A Claude seat restarts with `--continue` whenever its
 * conversation directory holds a transcript. After a seat had run on another
 * runtime for two days, switching it back reopened the conversation from before
 * the switch: every handoff written in between was skipped, and the session
 * resumed as if nothing had happened. A conversation is only a valid resume
 * point if nothing newer was recorded somewhere else.
 *
 * Two signals, both from files the seat already writes:
 *   - the runtime or model differs from the last session's (last-session.json);
 *   - (Claude) the newest handoff document is newer than the newest transcript.
 *
 * When either holds, the caller starts fresh and points the new session at the
 * newest handoff document.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';

export const LAST_SESSION_FILE = 'last-session.json';

/**
 * A handoff counts as newer than the conversation only past this margin. The
 * session that writes a handoff keeps appending to its transcript afterwards,
 * so in the normal case the transcript is already newer; the margin absorbs
 * clock granularity, not real gaps.
 */
export const HANDOFF_NEWER_MARGIN_MS = 60_000;

export interface SessionIdentity {
  runtime: string;
  model: string;
}

export interface FileStamp {
  path: string;
  mtimeMs: number;
}

export function readLastSession(stateDir: string): SessionIdentity | null {
  try {
    const data = JSON.parse(readFileSync(join(stateDir, LAST_SESSION_FILE), 'utf-8'));
    if (typeof data.runtime !== 'string' || typeof data.model !== 'string') return null;
    return { runtime: data.runtime, model: data.model };
  } catch {
    return null;
  }
}

export function writeLastSession(stateDir: string, identity: SessionIdentity, now: Date = new Date()): void {
  atomicWriteSync(
    join(stateDir, LAST_SESSION_FILE),
    JSON.stringify({ ...identity, started_at: now.toISOString() }) + '\n',
  );
}

function newestMatching(dir: string, suffix: string): FileStamp | null {
  let best: FileStamp | null = null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    const path = join(dir, name);
    try {
      const mtimeMs = statSync(path).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
    } catch { /* vanished between readdir and stat */ }
  }
  return best;
}

/** Newest handoff document under `<agentDir>/memory/handoffs/`, or null. */
export function newestHandoff(agentDir: string): FileStamp | null {
  return newestMatching(join(agentDir, 'memory', 'handoffs'), '.md');
}

/** Newest transcript (`*.jsonl`) in a Claude conversation directory, or null. */
export function newestTranscript(convDir: string): FileStamp | null {
  return newestMatching(convDir, '.jsonl');
}

export interface FreshDecisionInput {
  last: SessionIdentity | null;
  current: SessionIdentity;
  /** Newest handoff document, or null. */
  handoff: FileStamp | null;
  /** Newest transcript of the conversation that would be resumed; null when not applicable. */
  transcript: FileStamp | null;
}

/**
 * Returns why a resume would be stale, or null when resuming is safe.
 * A missing last-session record (first start on this version) is NOT a reason:
 * there is nothing to compare against, and forcing every seat fresh on upgrade
 * would be its own context loss.
 */
export function staleResumeReason(input: FreshDecisionInput): string | null {
  const { last, current, handoff, transcript } = input;
  if (last && last.runtime !== current.runtime) {
    return `runtime changed (${last.runtime} -> ${current.runtime})`;
  }
  if (last && last.model !== current.model) {
    return `model changed (${last.model} -> ${current.model})`;
  }
  if (handoff && transcript && handoff.mtimeMs > transcript.mtimeMs + HANDOFF_NEWER_MARGIN_MS) {
    return 'a handoff document is newer than the conversation';
  }
  return null;
}
