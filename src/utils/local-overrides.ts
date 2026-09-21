import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Read an agent's local overrides: `{agentDir}/local/*.md`.
 *
 * ONE COPY OF THE FILE-SET RULE, SHARED BY EVERY ADAPTER.
 *
 * The rule was previously inline in AgentPTY only, which is how a Codex seat
 * came to receive none of it: the behaviour lived in one adapter's method body,
 * so there was nothing for a second adapter to be measured against. Same shape
 * as CTX_ORCHESTRATOR_AGENT (see utils/orchestrator-env.ts) — resolution is
 * shared, the USE stays in each adapter so a source-level test can see both.
 *
 * ⛔ TOP LEVEL ONLY. THIS MUST NOT RECURSE.
 * The claude-code path is the glob `{agentDir}/local/*.md`, and a glob does not
 * descend. `local/` is a working directory: on the one seat in this fleet that
 * uses it, the top level is 4 files / 40,657 bytes while the tree below holds
 * subdirectories of unrelated material. Recursing would change what a seat is
 * told about itself as a side effect of someone filing a note in a subfolder.
 * Delivering the subdirectories is a separate decision and does not belong in
 * an adapter (tracked: task 07263733).
 *
 * PER-FILE ERROR HANDLING IS DELIBERATE AND IS A BEHAVIOUR CHANGE FROM THE
 * INLINE VERSION. AgentPTY wrapped the whole loop in one try/catch, so a single
 * unreadable entry discarded EVERY override, silently — an agent would boot
 * without its instructions and nothing anywhere would say so. Here an unreadable
 * file is skipped and named in `skipped`; the rest are still delivered.
 */
export interface LocalOverrides {
  /** Concatenated file contents, '\n\n'-joined in filename sort order. Empty when there are none. */
  content: string;
  /** Basenames actually read, in the order they were concatenated. */
  files: string[];
  /** Byte length of `content`. */
  bytes: number;
  /** Basenames that matched *.md but could not be read (or were not regular files). */
  skipped: string[];
}

const EMPTY: LocalOverrides = { content: '', files: [], bytes: 0, skipped: [] };

export function readLocalOverrides(agentDir: string | undefined): LocalOverrides {
  if (!agentDir) return EMPTY;
  const localDir = join(agentDir, 'local');
  if (!existsSync(localDir)) return EMPTY;

  let entries: string[];
  try {
    entries = readdirSync(localDir).filter(f => f.endsWith('.md')).sort();
  } catch {
    return EMPTY;
  }

  const parts: string[] = [];
  const files: string[] = [];
  const skipped: string[] = [];
  for (const name of entries) {
    const p = join(localDir, name);
    try {
      // A directory named `something.md` matches the glob and is not readable
      // as a file. Without this it throws and — in the inline version — took
      // every other override down with it.
      if (!statSync(p).isFile()) { skipped.push(name); continue; }
      parts.push(readFileSync(p, 'utf-8'));
      files.push(name);
    } catch {
      skipped.push(name);
    }
  }

  const content = parts.join('\n\n');
  return { content, files, bytes: Buffer.byteLength(content, 'utf-8'), skipped };
}

/**
 * Boot cap for overrides delivered as a TURN rather than as a system prompt.
 * Mirrors the codex adapter's cap: DROP LOUDLY, never truncate. A truncated
 * instruction set is worse than none, because it reads as complete.
 */
export const MAX_TURN_OVERRIDE_BYTES = 128 * 1024;

/**
 * The caveat that travels WITH the content, for every runtime that has no
 * system-prompt equivalent.
 *
 * ⛔ THE LIMIT HAS TO BE WRITTEN WHERE THE SEAT READS IT (chief's ruling). A caveat that
 * lives only in an adapter is a caveat the affected agent never sees — and this particular
 * limit is one ONLY THE AGENT can act on, because after a compaction it is the only party
 * still present.
 */
export function turnDeliveryCaveat(runtime: string): string {
  return (
    `DELIVERY NOTE (${runtime} interim): this block arrived as a ` +
    'CONVERSATION TURN, not as a system prompt. It MAY BE COMPACTED AWAY ' +
    'later in this session, and nothing will announce that it has gone. ' +
    'RE-READ {agentDir}/local/*.md AT EVERY HEARTBEAT and treat its absence ' +
    'from this transcript as expected, not as evidence it was never sent.'
  );
}

/**
 * Compose the boot block for a runtime with NO `--append-system-prompt`.
 *
 * ⛔ WHY THIS EXISTS RATHER THAN THE FLAG. Measured 2026-09-20: `hermes --help` offers
 * `-z/--oneshot`, `-m`, `--usage-file` and subcommands, and `opencode --help` offers
 * `--prompt`. NEITHER HAS `--append-system-prompt`. Pushing that flag into `buildClaudeArgs`
 * hands argparse an unrecognised option and THE SEAT DOES NOT BOOT AT ALL — strictly worse
 * than the missing instructions it was meant to fix.
 *
 * Returns the prompt unchanged when there is nothing to add, so a seat with no `local/`
 * directory is byte-for-byte unaffected.
 */
export function composeTurnOverrideBlock(
  runtime: string,
  overrides: LocalOverrides,
  prompt: string,
): { text: string; note: string | null } {
  if (!overrides.content) {
    return { text: prompt, note: null };
  }
  if (overrides.bytes > MAX_TURN_OVERRIDE_BYTES) {
    return {
      text: prompt,
      note:
        `[${runtime}] local/ overrides DROPPED: ${overrides.bytes} bytes over the ` +
        `${MAX_TURN_OVERRIDE_BYTES}-byte boot cap (${overrides.files.length} files: ` +
        `${overrides.files.join(', ')}). Booting WITHOUT them.`,
    };
  }
  const block =
    `<local-overrides source="{agentDir}/local/*.md" files="${overrides.files.join(',')}" bytes="${overrides.bytes}">\n` +
    `${turnDeliveryCaveat(runtime)}\n\n` +
    `${overrides.content}\n` +
    `</local-overrides>`;
  return {
    text: prompt.trim() ? `${block}\n\n${prompt}` : block,
    note:
      `[${runtime}] local/ overrides injected: ${overrides.files.length} files, ` +
      `${overrides.bytes} bytes (${overrides.files.join(', ')})`,
  };
}
