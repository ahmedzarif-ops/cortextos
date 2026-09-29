import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// The Agent Effectiveness card counts category-'error' events at severity
// error|critical. Every shipped event-logging skill must carry the same
// severity guidance, or agents keep logging recovered retries and findings
// about OTHER agents as their own errors (chief: 56 on the card, most of them
// one of those two shapes).
const ROOT = join(__dirname, '..', '..', '..');

function skillCopies(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) skillCopies(p, out);
    else if (p.endsWith(join('event-logging', 'SKILL.md'))) out.push(p);
  }
  return out;
}

function severitySection(text: string): string {
  const start = text.indexOf("The dashboard's per-agent **errors** figure");
  const end = text.indexOf('Never lower a severity', start);
  return start < 0 || end < 0 ? '' : text.slice(start, end);
}

describe('event-logging skills: severity guidance', () => {
  const copies = [...skillCopies(join(ROOT, 'templates')), ...skillCopies(join(ROOT, 'community'))];

  it('finds the shipped copies', () => {
    expect(copies.length).toBeGreaterThanOrEqual(5);
  });

  it('every copy carries the same guidance, including the recovered-retry and other-agent rows', () => {
    const sections = copies.map((f) => severitySection(readFileSync(f, 'utf-8')));
    for (const [i, s] of sections.entries()) {
      expect(s, copies[i]).toContain('retry or corrected form succeeded');
      expect(s, copies[i]).toContain("ANOTHER agent's work");
      expect(s, copies[i]).toBe(sections[0]);
    }
  });
});
