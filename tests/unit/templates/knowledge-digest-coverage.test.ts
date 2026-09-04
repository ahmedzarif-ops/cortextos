import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * The template digest generator shipped a kbC parser that matched NOTHING: it
 * required the closing `**` immediately after the `(date, seat)` parenthetical,
 * while every real kbC line closes `**` after the TITLE. 74 entries in the live
 * org file, 0 indexed — and `--check` returned OK the whole time, because
 * `--check` diffs a fresh generation against the file on disk. That is
 * STALENESS. A parser that matches nothing regenerates byte-identically
 * forever, so the verifier reports success at full confidence.
 *
 * The prior test for this tool asserted only that the FILE EXISTS. A tool that
 * exists and parses nothing passes that assertion perfectly, which is why these
 * tests RUN it. `rows == enumerated` says nothing about `enumerated == exists`.
 */

const ROOT = join(__dirname, '..', '..', '..');
const TOOL = join(ROOT, 'templates', 'org', 'tools', 'make-knowledge-digest.py');

// Both real kbC shapes, one kbA rule and one section — plus a decoy that must
// NOT be counted, so a parser that matches too much fails too.
const FIXTURE = [
  '# Org knowledge',
  '',
  '## Decisions Log',
  '',
  '### #1 — a kbA rule, which is a different series',
  'body',
  '',
  '- **#24 (2026-09-04, city/chief) orgs/ is gitignored.** Any change to a live seat file.',
  '- **#25 (2026-09-04, city) a --help probe proves nothing.** Grep dist/cli.js instead.',
  '- **#173a — the `-latest` alias trap.** A `-latest` alias can move under you.',
  '- **#173b — a whole-request cliff.** It is not a per-message limit.',
  '- a plain bullet that is not a kbC entry at all',
  '- **not numbered** so it must not be counted',
  '',
].join('\n');

const EXPECTED_KBC = 4;

let dir: string;

function runTool(toolPath: string): { status: number; output: string } {
  try {
    const out = execFileSync('python3', [toolPath], { encoding: 'utf-8', stdio: 'pipe' });
    return { status: 0, output: out };
  } catch (e: any) {
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'digest-coverage-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  writeFileSync(join(dir, 'knowledge.md'), FIXTURE, 'utf-8');
  copyFileSync(TOOL, join(dir, 'tools', 'make-knowledge-digest.py'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('template digest generator: kbC coverage', () => {
  it('python3 is available — the tool cannot run without it', () => {
    // Deliberately NOT a skipIf. A silent skip here reproduces the exact defect
    // under test: an instrument that reports nothing and reads as a pass.
    const v = execFileSync('python3', ['--version'], { encoding: 'utf-8' });
    expect(v).toMatch(/^Python 3\./);
  });

  it('indexes every kbC entry in the source, both shapes', () => {
    const r = runTool(join(dir, 'tools', 'make-knowledge-digest.py'));
    expect(r.status).toBe(0);
    const digest = readFileSync(join(dir, 'knowledge-digest.md'), 'utf-8');
    expect(digest).toContain(`## kbC — dated entries (${EXPECTED_KBC})`);
    for (const key of ['kbC#24', 'kbC#25', 'kbC#173a', 'kbC#173b']) {
      expect(digest).toContain(key);
    }
  });

  it('does not count bullets that are not kbC entries', () => {
    const digest = readFileSync(join(dir, 'knowledge-digest.md'), 'utf-8');
    expect(digest).not.toContain('a plain bullet that is not a kbC entry');
    expect(digest).not.toContain('so it must not be counted');
  });

  it('still indexes the kbA series and the sections', () => {
    const digest = readFileSync(join(dir, 'knowledge-digest.md'), 'utf-8');
    expect(digest).toContain('## kbA — numbered rules (1)');
    expect(digest).toContain('kbA#1');
    expect(digest).toContain('Decisions Log');
  });

  it('HARD-FAILS when the kbC parser stops covering the source', () => {
    // The negative control IS the instrument. This restores the original broken
    // pattern and asserts the coverage assertion fires — the arm that never ran
    // is the arm that let this ship.
    const broken = join(dir, 'tools', 'broken.py');
    const src = readFileSync(TOOL, 'utf-8');
    const mutated = src.replace(
      /^INLINE = re\.compile\(.*$/m,
      'INLINE = re.compile(r"^- \\*\\*#(\\d+) \\(([^)]*)\\)\\*\\*\\s*[—-]?\\s*(.*)$")',
    );
    expect(mutated).not.toBe(src); // the mutation must actually apply
    writeFileSync(broken, mutated, 'utf-8');

    const r = runTool(broken);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('COVERAGE FAIL');
    expect(r.output).toContain(`${EXPECTED_KBC} kbC candidate lines`);
  });

  it('--check reports staleness, and staleness alone would not have caught this', () => {
    // Documents the limit that let the defect live: --check compares a fresh
    // generation to the file on disk, so a parser matching nothing is stable.
    const tool = join(dir, 'tools', 'make-knowledge-digest.py');
    const r = execFileSync('python3', [tool, '--check'], { encoding: 'utf-8' });
    expect(r).toContain('OK:');
  });
});
