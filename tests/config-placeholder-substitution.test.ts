import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A placeholder that no substitution pass replaces reaches disk LITERALLY and is
 * then read as a real value. `templates/hermes/config.json` carried
 * `"model": "{{model}}"`, and `agent-pty.ts` does `if (this.config.model)
 * args.push('--model', this.config.model)` — a non-empty string, so the branch
 * is TAKEN and the runtime is launched with `--model {{model}}`.
 *
 * ⛔ THE SHAPE THAT MAKES THIS CLASS DANGEROUS: an unsubstituted placeholder is
 * TRUTHY. It does not read as missing, so every `if (value)` guard that exists
 * to fall back to a default is SATISFIED by the broken value and the default
 * never runs. `agent-pty.ts:140-144` is the same shape and worse — a truthy
 * `{{timezone}}` sets `TZ` to the literal AND suppresses the `else if
 * (process.env.TZ)` that would have inherited the system zone.
 *
 * ONLY FOUR NAMES ARE EVER SUBSTITUTED, and they are read from the code rather
 * than from a doc:
 *   src/cli/add-agent.ts — {{agent_name}}, {{org}}, {{current_timestamp}}
 *   src/cli/init.ts      — {{org_name}}
 * Anything else in a shipped `config.json` survives the copy.
 */
const SUBSTITUTED = new Set(['agent_name', 'org', 'current_timestamp', 'org_name']);

const REPO_ROOT = resolve(__dirname, '..');
const ROOTS = ['templates', 'community/agents'];

function findConfigs(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) findConfigs(p, out);
    else if (e === 'config.json') out.push(p);
  }
  return out;
}

const CONFIGS = ROOTS.flatMap((r) => findConfigs(join(REPO_ROOT, r)));

describe('shipped config.json files carry no placeholder that nothing substitutes', () => {
  // The set must not be empty, or every assertion below passes vacuously.
  // A sweep that found no files and a sweep that found no violations are
  // indistinguishable in the result; this is what separates them.
  it('finds config.json files to check at all', () => {
    expect(CONFIGS.length).toBeGreaterThan(0);
  });

  it.each(CONFIGS.map((p) => [relative(REPO_ROOT, p), p] as const))(
    '%s',
    (rel, abs) => {
      const found = [...readFileSync(abs, 'utf-8').matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map(
        (m) => m[1],
      );
      const unsubstituted = [...new Set(found)].filter((n) => !SUBSTITUTED.has(n));
      expect(
        unsubstituted,
        `${rel}: placeholder(s) nothing substitutes — they reach disk literally and read as real, truthy values`,
      ).toEqual([]);
    },
  );

  // The must-stay-green arm. Without it, a bug that made SUBSTITUTED match
  // everything would turn the whole suite green and look like a pass.
  it('still recognises a real substituted placeholder as allowed', () => {
    expect(SUBSTITUTED.has('agent_name')).toBe(true);
    expect(SUBSTITUTED.has('model')).toBe(false);
  });
});
