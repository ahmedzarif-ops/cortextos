import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * The Codex boot protocol has to survive as an ARTEFACT, not as a paragraph
 * somebody remembers. It was written because a Codex seat reading its bootstrap
 * set whole reached 59% of a 258,400-token window before doing any work; the
 * same seats reading by index booted at 15.5% and 25.8%.
 *
 * These assertions are deliberately about the INSTRUCTIONS, because the failure
 * mode is a well-meaning edit that restores "read ../../knowledge.md" and
 * silently puts the seats back where they started — no error, no exit code, just
 * a seat that runs out of room.
 */

const ROOT = join(__dirname, '..', '..', '..');
const CODEX_AGENTS = join(ROOT, 'templates', 'agent-codex', 'AGENTS.md');

describe('agent-codex template: boot context budget', () => {
  const text = readFileSync(CODEX_AGENTS, 'utf-8');

  it('points session start at the knowledge DIGEST, not the whole knowledge file', () => {
    expect(text).toContain('../../knowledge-digest.md');
  });

  it('does not instruct a bare whole-file read of knowledge.md', () => {
    // The file may still MENTION knowledge.md — it must, for grep and sed by
    // address. What must not survive is the original step-3 instruction.
    expect(text).not.toContain('Read org knowledge base: `../../knowledge.md`');
  });

  it('tails the daily memory file rather than reading it whole', () => {
    expect(text).toMatch(/tail -\d+ "memory\/\$\(date -u \+%Y-%m-%d\)\.md"/);
  });

  it('reads the unbounded files by heading first', () => {
    expect(text).toContain("grep -n '^#' GUARDRAILS.md");
    expect(text).toContain("grep -n '^#' MEMORY.md");
  });

  it('states the window it is budgeting against', () => {
    expect(text).toContain('258,400');
  });

  it('ships the digest generator the protocol depends on', () => {
    // An instruction that points at a tool absent from a fresh org is an
    // instruction that fails on first use.
    expect(existsSync(join(ROOT, 'templates', 'org', 'tools', 'make-knowledge-digest.py'))).toBe(true);
  });

  it('keeps the pinned-block carve-out (budget must not silently drop rules)', () => {
    // Reading by index is a reading strategy, not permission to skip content.
    expect(text).toMatch(/read even if truncated/i);
  });
});
