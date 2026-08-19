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

// Synchronous equivalent of the ansi-regex pattern used by strip-ansi. PTY
// lifecycle polling cannot await the ESM-only package, and Claude's TUI places
// cursor/private-mode sequences (for example ESC[1C and ESC[?25l) between
// visible words. The previous color-only regex left those sequences behind.
const ANSI_SYNC_PATTERN = /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

export function stripAnsiSync(text: string): string {
  if (!text.includes('\u001B') && !text.includes('\u009B')) return text;
  // Cursor-forward is commonly used instead of emitting literal spaces. Keep
  // the visible word boundary before removing the remaining control codes.
  const withVisibleSpacing = text.replace(/\u001B\[(\d*)C/g, (_match, width: string) =>
    ' '.repeat(Math.max(1, Number(width) || 1)));
  return withVisibleSpacing.replace(ANSI_SYNC_PATTERN, '');
}

/**
 * Ring buffer for PTY output. Replaces tmux capture-pane.
 * Stores raw output chunks and provides search/retrieval with ANSI stripping.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private maxChunks: number;
  private logPath: string | null;
  private bootstrapPattern: string | RegExp;

  constructor(maxChunks: number = 1000, logPath?: string, bootstrapPattern?: string | RegExp) {
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
    const text = stripAnsiSync(this.getRecent());
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
    const cleaned = stripAnsiSync(recent);

    if (this.bootstrapPattern === 'permissions') {
      // Claude's ready status bar uses `permissions: <mode>`. First-run trust
      // and bypass warnings also contain the word "permissions" (including a
      // lowercase occurrence in the pre-approved tools explanation), so a
      // bare substring falsely marks those blocking screens as bootstrapped.
      return /permissions\s*:\s*[a-z-]+/i.test(cleaned);
    }

    if (this.bootstrapPattern instanceof RegExp) {
      // Reset for deterministic repeated probes if an adapter ever supplies a
      // stateful global expression.
      this.bootstrapPattern.lastIndex = 0;
      return this.bootstrapPattern.test(cleaned);
    }

    return cleaned.includes(this.bootstrapPattern);
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
   */
  clear(): void {
    this.chunks = [];
  }
}
