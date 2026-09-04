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
