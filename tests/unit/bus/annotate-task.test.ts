/**
 * annotate-task: append a dated, attributed note WITHOUT rewriting the description.
 *
 * The gap (guard, 2026-09-04): no bus route could correct a task after creation —
 * `update-task` takes only `<id> <status>` — so corrections lived in chat prose and were
 * invisible to anyone reading the task later. Several tasks tonight arrived with a premise
 * that turned out to be wrong; the correction had nowhere to live on the task itself.
 *
 * The load-bearing invariant is that `description` is NEVER modified. A correction is a new
 * fact about the task, not a replacement for what was originally asked — keeping both is what
 * lets a reader see that the ask changed, when, and who changed it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTask, annotateTask, findTaskFile, readTaskAudit } from '../../../src/bus/task';
import type { BusPaths, Task } from '../../../src/types/index';

let root: string;
let paths: BusPaths;

function readTask(id: string): Task {
  const f = findTaskFile(paths, id);
  expect(f).not.toBeNull();
  return JSON.parse(readFileSync(f as string, 'utf-8'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'annotate-task-'));
  paths = { taskDir: join(root, 'tasks'), eventDir: join(root, 'events'), messageDir: join(root, 'messages') } as BusPaths;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('annotate-task', () => {
  const DESC = 'Original ask: fetch is dead since 08-24 and draft-init no-ops forever.';

  it('appends a note and leaves the description BYTE-IDENTICAL', () => {
    const id = createTask(paths, 'city', 'testorg', 'radar', { description: DESC });
    const before = readTask(id).description;

    annotateTask(paths, id, 'Premise inverted: the code works, nothing ran it.', 'city');

    const after = readTask(id);
    // The invariant, asserted on the raw stored string rather than on a summary of it.
    expect(after.description).toBe(before);
    expect(after.description).toBe(DESC);
    expect(after.annotations).toHaveLength(1);
    expect(after.annotations?.[0].text).toBe('Premise inverted: the code works, nothing ran it.');
    expect(after.annotations?.[0].agent).toBe('city');
    expect(after.annotations?.[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('accumulates notes in order rather than replacing the previous one', () => {
    const id = createTask(paths, 'city', 'testorg', 'x', { description: DESC });
    annotateTask(paths, id, 'first', 'city');
    annotateTask(paths, id, 'second', 'guard');
    annotateTask(paths, id, 'third', 'chief');

    const notes = readTask(id).annotations ?? [];
    expect(notes.map((n) => n.text)).toEqual(['first', 'second', 'third']);
    // Attribution is per-note: a thread of corrections from different authors must not
    // collapse into one voice.
    expect(notes.map((n) => n.agent)).toEqual(['city', 'guard', 'chief']);
    expect(readTask(id).description).toBe(DESC);
  });

  /**
   * FAIL LOUDLY. An annotation that silently vanishes is worse than none: the next reader
   * sees a task with no note and concludes there was nothing to say. Each of these must
   * THROW, not return quietly.
   */
  it('refuses an empty or whitespace-only note', () => {
    const id = createTask(paths, 'city', 'testorg', 'x', { description: DESC });
    for (const empty of ['', '   ', '\n\t ']) {
      expect(() => annotateTask(paths, id, empty, 'city')).toThrow(/empty/i);
    }
    expect(readTask(id).annotations ?? []).toHaveLength(0);
  });

  it('refuses a note with no author', () => {
    const id = createTask(paths, 'city', 'testorg', 'x', { description: DESC });
    expect(() => annotateTask(paths, id, 'a real note', '')).toThrow(/agent identity/i);
    expect(readTask(id).annotations ?? []).toHaveLength(0);
  });

  it('refuses an unknown task id rather than creating one', () => {
    expect(() => annotateTask(paths, 'task_0000000000000_00000000', 'note', 'city')).toThrow(/not found/i);
  });

  it('records the annotation in the audit log too', () => {
    const id = createTask(paths, 'city', 'testorg', 'x', { description: DESC });
    annotateTask(paths, id, 'a correction', 'city');
    const audit = readTaskAudit(paths, id);
    expect(audit.some((e) => e.note?.includes('a correction'))).toBe(true);
  });

  /**
   * POSITIVE CONTROL for the byte-identical assertion. If `description` were somehow
   * unwritable — a frozen field, a serializer that drops it — every assertion above would
   * pass vacuously. This proves the test can SEE a description change, so the equality
   * checks above are load-bearing rather than decorative.
   */
  it('POSITIVE CONTROL: the test can detect a description that DID change', () => {
    const id = createTask(paths, 'city', 'testorg', 'x', { description: DESC });
    const f = findTaskFile(paths, id) as string;
    expect(existsSync(f)).toBe(true);

    const mutated: Task = JSON.parse(readFileSync(f, 'utf-8'));
    mutated.description = 'REWRITTEN';
    require('fs').writeFileSync(f, JSON.stringify(mutated));

    expect(readTask(id).description).not.toBe(DESC);
  });
});
