import { appendFileSync, renameSync, statSync } from 'fs';
import { redactSecrets } from './redact.js';

// Dynamic import for strip-ansi (ESM module)
let stripAnsi: (text: string) => string;
async function loadStripAnsi() {
  if (!stripAnsi) {
    const mod = await import('strip-ansi');
    stripAnsi = mod.default;
  }
  return stripAnsi;
}

const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB — rotate before OS file-cache pressure builds

/**
 * Ring buffer for PTY output. Replaces tmux capture-pane.
 * Stores raw output chunks and provides search/retrieval with ANSI stripping.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private maxChunks: number;
  private logPath: string | null;
  private bootstrapPattern: string;
  /**
   * LATCH: has the bootstrap pattern EVER been in this buffer?
   *
   * ⛔ THIS LIVES HERE, NOT IN A CALLER, BECAUSE THIS IS WHERE THE FACT ARRIVES.
   * `isBootstrapped()` answers "is the pattern on screen right now" — a momentary
   * observation over a ring that evicts. "Ever bootstrapped" is monotonic. A caller
   * that latches at its own observation site can only latch what it happens to be
   * looking at: OBSERVATION SITES ARE SAMPLED, INGRESS IS CONTINUOUS, and between
   * any two samples the evidence can be evicted. Set on push, never unset.
   */
  private _everBootstrapped = false;

  constructor(maxChunks: number = 1000, logPath?: string, bootstrapPattern?: string) {
    this.maxChunks = maxChunks;
    this.logPath = logPath || null;
    this.bootstrapPattern = bootstrapPattern || 'permissions';
  }

  /**
   * Push new output data into the buffer.
   * Also streams to log file if configured.
   *
   * Secret redaction runs once at the top via `redactSecrets` and the
   * scrubbed string is used for BOTH the in-memory ring buffer AND the
   * disk log. Without this, any JWT or session cookie an agent's shell
   * happens to print (e.g. curl -v against an authenticated endpoint)
   * would end up persisted to stdout.log verbatim. See src/pty/redact.ts
   * for the rationale + the known chunk-boundary limitation.
   */
  push(data: string): void {
    const safe = redactSecrets(data);

    this.chunks.push(safe);
    if (this.chunks.length > this.maxChunks) {
      this.chunks.shift();
    }

    // OBSERVE THE BOOTSTRAP PATTERN AT INGRESS, while the chunk that carries it is
    // guaranteed to still be in the ring. A caller asking later may be asking after
    // a thousand chunks have evicted it.
    //
    // ⚠ COST, STATED RATHER THAN GLOSSED: this is a full-ring scan per chunk, and it
    // runs ONLY until the latch is set — the `!this._everBootstrapped` short-circuit
    // means a bootstrapped session pays nothing at all, which is every session after
    // its first seconds. A cheaper incremental scan of just the new chunk would NOT be
    // equivalent: `isBootstrapped()` is a whole-window predicate (for the 'permissions'
    // pattern it excludes the trust prompt by looking for 'trust' and '> ' anywhere in
    // the window) and the ring EVICTS, so its answer can change without the new chunk
    // containing anything relevant. An incremental accumulator cannot reproduce that,
    // and a wrong-but-fast latch here is the exact class of bug this change exists to
    // remove.
    if (!this._everBootstrapped && this.isBootstrapped()) {
      this._everBootstrapped = true;
    }

    // Stream to log file (replaces tmux pipe-pane)
    if (this.logPath) {
      try {
        try {
          const size = statSync(this.logPath).size;
          if (size >= MAX_LOG_BYTES) {
            try { renameSync(this.logPath, this.logPath + '.1'); } catch { /* ignore */ }
          }
        } catch { /* file doesn't exist yet — skip rotation check */ }
        appendFileSync(this.logPath, safe, 'utf-8');
      } catch {
        // Ignore log write errors
      }
    }
  }

  /**
   * Get the last N chunks of output joined together.
   */
  getRecent(n?: number): string {
    const count = n || this.chunks.length;
    return this.chunks.slice(-count).join('');
  }

  /**
   * Search for a pattern in recent output (ANSI codes stripped).
   * Used for bootstrap detection ("permissions" text).
   */
  async search(pattern: string): Promise<boolean> {
    const strip = await loadStripAnsi();
    const text = strip(this.getRecent());
    return text.includes(pattern);
  }

  /**
   * Synchronous search for simple patterns.
   * Does basic ANSI stripping inline (strips ESC[ sequences).
   */
  searchSync(pattern: string): boolean {
    const text = this.getRecent().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    return text.includes(pattern);
  }

  /**
   * Check if agent has bootstrapped (ready-for-input signal appeared).
   *
   * For Claude Code: looks for the "permissions" status-bar text.
   * For Hermes: looks for the "❯" prompt character (configurable via constructor).
   * The bootstrap pattern is set at construction time by the PTY class.
   */
  isBootstrapped(): boolean {
    const recent = this.getRecent();
    const cleaned = recent.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    if (this.bootstrapPattern === 'permissions') {
      // Claude Code: exclude trust-folder prompt false positives.
      // The trust prompt shows "trust this folder" before the status bar appears.
      if (cleaned.includes('trust') && !cleaned.includes('> ')) {
        return false;
      }
    }

    return cleaned.includes(this.bootstrapPattern);
  }

  /**
   * Has this session EVER been observed bootstrapped?
   *
   * Monotonic: once true, always true for the life of this buffer. Use this — never
   * `isBootstrapped()` — for any question of the form "did this session start",
   * "is this seat live", "has it got past first-run". `isBootstrapped()` answers the
   * different question "is the pattern visible right now", and the two agree only
   * during the window before eviction.
   *
   * The live re-check below is a floor, not the mechanism: ingress already latched
   * anything that arrived through `push()`. It costs one scan per call while
   * unlatched and nothing once latched, and it means this getter can never answer
   * worse than `isBootstrapped()` would have.
   */
  hasEverBootstrapped(): boolean {
    if (this._everBootstrapped) return true;
    if (this.isBootstrapped()) {
      this._everBootstrapped = true;
      return true;
    }
    return false;
  }

  /**
   * Get the total size of buffered output in bytes.
   * Useful for activity detection (typing indicator).
   */
  getSize(): number {
    let size = 0;
    for (const chunk of this.chunks) {
      size += chunk.length;
    }
    return size;
  }

  /**
   * Clear the buffer.
   *
   * ⛔ DELIBERATELY DOES NOT CLEAR `_everBootstrapped`. Emptying the ring discards
   * the EVIDENCE; it does not un-happen the event. Resetting the latch here would
   * reintroduce the whole defect through a second door — a caller that clears the
   * buffer would silently make a live session report as never-started. A new
   * session gets a new OutputBuffer, which is where the latch is meant to reset.
   */
  clear(): void {
    this.chunks = [];
  }
}
