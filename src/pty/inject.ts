import { createHash } from 'crypto';

// Bracketed paste mode escape sequences
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Key escape sequences for TUI navigation
export const KEYS = {
  ENTER: '\r',
  CTRL_C: '\x03',
  DOWN: '\x1b[B',
  UP: '\x1b[A',
  SPACE: ' ',
  ESCAPE: '\x1b',
  TAB: '\t',
} as const;

/**
 * Message deduplication via MD5 hash.
 * Prevents double-injection on crash recovery.
 * Matches bash fast-checker.sh dedup pattern.
 */
export class MessageDedup {
  private hashes: string[] = [];
  private maxEntries: number;

  constructor(maxEntries: number = 100) {
    this.maxEntries = maxEntries;
  }

  /**
   * Returns true if this content has been seen before (duplicate).
   */
  isDuplicate(content: string): boolean {
    const hash = createHash('md5').update(content).digest('hex');
    if (this.hashes.includes(hash)) {
      return true;
    }
    this.hashes.push(hash);
    if (this.hashes.length > this.maxEntries) {
      this.hashes.shift();
    }
    return false;
  }

  clear(): void {
    this.hashes = [];
  }
}

/**
 * Inject a message into a PTY process using bracketed paste mode.
 * Replaces tmux load-buffer + paste-buffer pattern.
 *
 * Bracketed paste mode wraps the content so the terminal treats it as
 * pasted text rather than typed input. This prevents special characters
 * from being interpreted as commands.
 *
 * @param write Function to write to the PTY (pty.write)
 * @param content The message content to inject
 * @param enterDelay Milliseconds to wait before sending Enter (default 300ms)
 */
export function injectMessage(
  write: (data: string) => void,
  content: string,
  enterDelay: number = 300,
  onEnterError?: (message: string) => void,
): void {
  // For very large messages, chunk the write to avoid overwhelming the PTY buffer
  const MAX_CHUNK = 4096;

  if (content.length <= MAX_CHUNK) {
    write(PASTE_START + content + PASTE_END);
  } else {
    // Chunked write for large messages
    write(PASTE_START);
    for (let i = 0; i < content.length; i += MAX_CHUNK) {
      write(content.slice(i, i + MAX_CHUNK));
    }
    write(PASTE_END);
  }

  // Send Enter after a short delay to submit the pasted content.
  // Why the try/catch: the write callback captures `this.pty` (or similar
  // nullable PTY handle) via closure in callers. If the PTY is torn down
  // during the enterDelay window — e.g. hard-restart IPC kills the child —
  // the callback will read `null.write` and throw. Swallowing here keeps
  // the daemon process alive; the dropped Enter is the acceptable cost.
  // Root cause: PR #196 fixed three this.pty! callers in agent-process.ts
  // but missed worker-process.ts:93. This try/catch is the structural fix
  // that covers every present and future caller.
  setTimeout(() => {
    try {
      write(KEYS.ENTER);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // ⛔ THE ENTER IS THE SUBMIT, AND WITHOUT IT THE CONTENT IS NOT DELIVERED —
      // it sits in the runtime's composer, unsent, until some LATER injection's Enter
      // flushes it. Observed: content pasted here surfaced 73 minutes later, prepended
      // to the next injection, inside a single turn.
      // This used to be a bare `console.warn`, which meant the one step that actually
      // submits could fail while every layer above reported success. The callback lets
      // a caller that has a real logger or an operator-visible surface record it;
      // `console.warn` remains the default so existing callers are unaffected.
      const line = `[inject] deferred Enter failed — content was written but NOT submitted: ${msg}`;
      if (onEnterError) {
        onEnterError(line);
      } else {
        console.warn(line);
      }
    }
  }, enterDelay);
}

/**
 * Did an injected message stay UNSENT in the runtime's composer?
 *
 * Observed 2026-09-25 04:14:50Z on the chief seat: `injectMessage` wrote the paste and,
 * 300 ms later, the Enter — no write error, `onEnterError` never fired — yet the screen
 * sat on `❯ [Pasted text #1 +8 lines]` for four minutes while the owner waited. Claude
 * Code was still in its "Pasting…" state when the Enter arrived and dropped it. This is
 * a DIFFERENT failure from the one `onEnterError` covers (a PTY torn down mid-window):
 * here every write succeeded and the message was still not delivered.
 *
 * The composer is the text after the LAST prompt glyph on screen, up to the input box's
 * bottom border. It holds an unsent message when it shows Claude Code's collapsed-paste
 * placeholder, or when it starts with the head of the content we just injected.
 * A false positive costs one extra Enter on an empty composer, which is a no-op; a
 * false negative is a message the owner never gets an answer to. Bias accordingly.
 */
export function composerHoldsUnsent(screen: string, content: string): boolean {
  const clean = screen
    .replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0e-\x1f]/g, '');
  const at = clean.lastIndexOf('\u276f'); // ❯
  if (at < 0) return false;
  // The COMPOSER sits inside the input box, so a box border comes right before its glyph. An ECHO of a
  // message already sent uses the same glyph with no border before it. Without this, a running turn whose
  // input box had not been redrawn yet read as "unsent" — seen live on the first boot after the deploy
  // (2026-09-25 20:58Z: sentinel + social logged a retry and a false STILL NOT SUBMITTED while both seats
  // were answering). Measured on chief's screen log: message-after-glyph WITHOUT a border 6200×, WITH 55×.
  const before = clean.slice(Math.max(0, at - 6), at).replace(/\s+/g, '');
  if (!before.endsWith('\u2500')) return false;
  const composer = clean.slice(at + 1).split(/\u2500|\n/)[0].replace(/\s+/g, ' ').trim();
  if (!composer) return false;
  if (/^\[Pasted text #\d+/.test(composer)) return true;
  // At least 12 matched characters, never fewer: a 1-3 char composer would otherwise
  // "match" the opening `===` that almost every injected message starts with (guard he6bj).
  const head = content.replace(/\s+/g, ' ').trim().slice(0, 24);
  const m = Math.min(head.length, composer.length);
  return m >= 12 && composer.slice(0, m) === head.slice(0, m);
}

/**
 * Send a sequence of keys to the PTY for TUI navigation.
 * Used for AskUserQuestion option selection and Plan mode approval.
 *
 * @param write Function to write to the PTY
 * @param keys Array of key sequences to send
 * @param delay Milliseconds between each key (default 100ms)
 */
export async function sendKeySequence(
  write: (data: string) => void,
  keys: string[],
  delay: number = 100,
): Promise<void> {
  for (const key of keys) {
    write(key);
    await sleep(delay);
  }
}

/**
 * Navigate to a specific option in a TUI list and select it.
 * Matches bash fast-checker.sh AskUserQuestion navigation.
 *
 * @param write PTY write function
 * @param optionIndex 0-based index of the option to select
 * @param submit Whether to press Enter after selection
 */
export async function selectOption(
  write: (data: string) => void,
  optionIndex: number,
  submit: boolean = true,
): Promise<void> {
  // Navigate down to the option
  for (let i = 0; i < optionIndex; i++) {
    write(KEYS.DOWN);
    await sleep(100);
  }
  await sleep(200);

  if (submit) {
    write(KEYS.ENTER);
  }
}

/**
 * Toggle options for multi-select TUI and submit.
 * Matches bash fast-checker.sh multi-select pattern.
 */
export async function toggleAndSubmit(
  write: (data: string) => void,
  selectedIndices: number[],
  totalOptions: number,
): Promise<void> {
  const sorted = [...selectedIndices].sort((a, b) => a - b);
  let currentPos = 0;

  for (const idx of sorted) {
    const moves = idx - currentPos;
    for (let i = 0; i < moves; i++) {
      write(KEYS.DOWN);
      await sleep(100);
    }
    write(KEYS.SPACE);
    await sleep(100);
    currentPos = idx;
  }

  // Navigate to Submit button (past all options + "Other")
  const submitPos = totalOptions + 1;
  const remaining = submitPos - currentPos;
  for (let i = 0; i < remaining; i++) {
    write(KEYS.DOWN);
    await sleep(100);
  }
  await sleep(200);
  write(KEYS.ENTER);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
