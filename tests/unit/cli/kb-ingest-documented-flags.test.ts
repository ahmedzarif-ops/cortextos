import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { busCommand } from '../../../src/cli/bus';

// Templates and community agents documented `kb-ingest --collection memory-$AGENT`,
// a flag the CLI never had. Agents copied the example into their heartbeats and
// every memory refresh failed with "unknown option --collection" — ~10 logged
// error events across sentinel, growth and chief before anyone traced it.
// This guards every documented kb-ingest example against the real option list.

const ROOT = join(__dirname, '..', '..', '..');
const DOC_DIRS = ['templates', 'community', 'skills', 'docs'];

function markdownFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) markdownFiles(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** Each `bus kb-ingest` invocation, with backslash-continued lines joined. */
function kbIngestInvocations(text: string): string[] {
  const joined = text.replace(/\\\n/g, ' ');
  return joined.split('\n').filter((l) => /bus kb-ingest\b/.test(l));
}

describe('documented kb-ingest examples use only real flags', () => {
  const cmd = busCommand.commands.find((c) => c.name() === 'kb-ingest')!;
  const known = new Set(cmd.options.map((o) => o.long));

  it('the CLI defines the flags this test relies on', () => {
    expect(known.has('--scope')).toBe(true);
    expect(known.has('--collection')).toBe(false);
  });

  it('no template, community agent, skill or doc passes an unknown kb-ingest flag', () => {
    const offenders: string[] = [];
    for (const d of DOC_DIRS) {
      for (const file of markdownFiles(join(ROOT, d))) {
        for (const line of kbIngestInvocations(readFileSync(file, 'utf-8'))) {
          const invocation = line.slice(line.indexOf('kb-ingest'));
          for (const flag of invocation.match(/(?<=\s)--[a-z][a-z-]*/g) ?? []) {
            if (!known.has(flag)) offenders.push(`${file.slice(ROOT.length + 1)}: ${flag}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
