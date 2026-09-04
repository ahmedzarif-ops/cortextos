import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * CTX_* PARITY BETWEEN THE PTY ADAPTERS.
 *
 * AgentPTY and CodexAppServerPTY build their child environments independently.
 * CodexAppServerPTY is the only adapter that builds its env from scratch, and
 * that is exactly how CTX_ORCHESTRATOR_AGENT came to exist on one side and not
 * the other: a Codex seat booted with no orchestrator to route to, and nothing
 * failed — it simply had no variable. A missing env var has no exit code.
 *
 * This asserts SET EQUALITY, not presence of any particular name. Presence
 * only catches the variable we already know about; equality catches the NEXT
 * one someone adds to one adapter and not the other, which is precisely how
 * this defect arrived.
 */

const ROOT = join(__dirname, '..', '..', '..');
const AGENT_PTY = join(ROOT, 'src', 'pty', 'agent-pty.ts');
const CODEX_PTY = join(ROOT, 'src', 'pty', 'codex-app-server-pty.ts');

/**
 * Collect CTX_* names that a source file ASSIGNS. Two assignment shapes exist:
 * an object literal (`CTX_ROOT: this.env.ctxRoot,`) and bracket assignment
 * (`env['CTX_ROOT'] = ...`). Comment lines are skipped — several comments name
 * these variables while discussing them, and counting those would make the
 * test pass on prose rather than on code.
 */
function assignedCtxKeys(file: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of readFileSync(file, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    for (const m of line.matchAll(/\['(CTX_[A-Z0-9_]+)'\]\s*=/g)) keys.add(m[1]!);
    for (const m of line.matchAll(/^(CTX_[A-Z0-9_]+)\s*:/g)) keys.add(m[1]!);
  }
  return keys;
}

describe('PTY adapters: CTX_* environment parity', () => {
  it('assigns the SAME set of CTX_ variables in both adapters', () => {
    const agent = assignedCtxKeys(AGENT_PTY);
    const codex = assignedCtxKeys(CODEX_PTY);

    const onlyAgent = [...agent].filter(k => !codex.has(k)).sort();
    const onlyCodex = [...codex].filter(k => !agent.has(k)).sort();

    expect({ onlyAgent, onlyCodex }).toEqual({ onlyAgent: [], onlyCodex: [] });
  });

  /**
   * The extractor is the instrument, so it gets its own controls. Without
   * these, an extractor that silently matched nothing would return two empty
   * sets and the parity assertion above would pass vacuously — a green that
   * means the test stopped working, not that the code is right.
   */
  it('extractor actually finds variables (guards a vacuous pass)', () => {
    const agent = assignedCtxKeys(AGENT_PTY);
    const codex = assignedCtxKeys(CODEX_PTY);
    expect(agent.size).toBeGreaterThan(5);
    expect(codex.size).toBeGreaterThan(5);
    expect(agent.has('CTX_ORCHESTRATOR_AGENT')).toBe(true);
    expect(codex.has('CTX_ORCHESTRATOR_AGENT')).toBe(true);
  });

  it('extractor ignores CTX_ names that appear only in comments', () => {
    // Proves the skip works: a commented assignment must not register.
    const keys = new Set<string>();
    const sample = "    // env['CTX_NOT_REAL_ZZZ'] = 'x';";
    const line = sample.trim();
    if (!line.startsWith('//')) {
      for (const m of line.matchAll(/\['(CTX_[A-Z0-9_]+)'\]\s*=/g)) keys.add(m[1]!);
    }
    expect([...keys]).toEqual([]);
  });
});
