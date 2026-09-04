/**
 * mmrag read commands must FAIL CLOSED when the store is not there to read.
 *
 * The defect (guard a1oiu, review of PR #12 at 84e0698): the PR closed the UNOPENABLE-store
 * arm, but `chromadb.PersistentClient(path=...)` CREATES the path it is handed. So a mis-set
 * MMRAG_CHROMADB_DIR never raised — chroma built an empty store at the wrong place and every
 * reader answered "No documents" at rc=0.
 *
 * Measured on the pre-fix code, 2026-09-04: `list --collection agent-city` against a path that
 * did not exist printed "No documents in collection 'agent-city'" at rc=0 and left a 188KB
 * chroma.sqlite3 behind.
 *
 * THE RATCHET IS THE REASON THIS IS A TEST AND NOT A NICER ERROR STRING. After that first run
 * the wrong path EXISTS and holds a real, valid, empty store, so it looks MORE legitimate on
 * every subsequent run and the evidence is gone. `expect(no directory created)` is therefore
 * the load-bearing assertion here, not the exit code.
 *
 * These run on plain `python3`: the guard fires BEFORE `import chromadb`, so no venv is needed.
 * That is also what the second test proves — it distinguishes the two different rc=2s, so a
 * pass here cannot be an ImportError wearing the guard's clothes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MMRAG = join(__dirname, '..', '..', 'knowledge-base', 'scripts', 'mmrag.py');

let sandbox: string;
let configPath: string;

function runMmrag(args: string[], chromadbDir: string) {
  return spawnSync('python3', [MMRAG, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MMRAG_DIR: sandbox,
      MMRAG_CONFIG: configPath,
      MMRAG_CHROMADB_DIR: chromadbDir,
    },
  });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mmrag-store-'));
  // A config that EXISTS. Without it mmrag exits 1 with "Config not found" — which is a
  // control that fails EARLIER than the thing under test, and would "confirm" this fix
  // without ever reaching the store guard.
  configPath = join(sandbox, 'config.json');
  writeFileSync(configPath, JSON.stringify({ default_collection: 'default' }));
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

describe('mmrag: a store that does not exist is not an empty store', () => {
  for (const cmd of [
    ['list', '--collection', 'agent-city'],
    ['status', '--collection', 'agent-city'],
    ['collections'],
  ]) {
    it(`\`${cmd[0]}\` refuses a nonexistent store AND CREATES NO DIRECTORY`, () => {
      const missing = join(sandbox, 'never-existed');
      expect(existsSync(missing)).toBe(false);

      const r = runMmrag(cmd, missing);

      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/refusing to read a knowledge store/);
      expect(r.stderr).toMatch(/the path does not exist/);
      expect(r.stderr).toMatch(/NOT an empty collection/);

      // THE ASSERTION THAT MATTERS. An exit code can be fixed while the side effect remains,
      // and the side effect is what destroys the evidence on every later run.
      expect(existsSync(missing)).toBe(false);
    });
  }

  it('refuses an EMPTY directory too — a directory nothing has ever written to is not a store', () => {
    const empty = join(sandbox, 'empty-dir');
    mkdirSync(empty);

    const r = runMmrag(['list', '--collection', 'agent-city'], empty);

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/the directory is empty/);
    // Still empty: refusing must not write anything either.
    expect(readdirSync(empty)).toHaveLength(0);
  });

  /**
   * POSITIVE CONTROL, and it is doing real work rather than decoration. Every test above
   * asserts rc=2 — but mmrag ALSO exits 2 when `import chromadb` fails, which is exactly what
   * happens on plain `python3`. Without this test, a guard that never ran would still produce
   * rc=2 everywhere and the suite would be green for the wrong reason.
   *
   * Here the path EXISTS and is non-empty, so the store guard passes and execution reaches the
   * import — a DIFFERENT rc=2 with a DIFFERENT message. That the two are distinguishable is
   * what proves the guard fired in the tests above, and that it fires BEFORE the import.
   */
  it('POSITIVE CONTROL: an existing non-empty path passes the guard and reaches the client', () => {
    const looksLikeAStore = join(sandbox, 'has-contents');
    mkdirSync(looksLikeAStore);
    writeFileSync(join(looksLikeAStore, 'chroma.sqlite3'), 'not really a database');

    const r = runMmrag(['list', '--collection', 'agent-city'], looksLikeAStore);

    expect(r.stderr).not.toMatch(/refusing to read a knowledge store/);
    expect(r.stderr).toMatch(/could not open the knowledge store|No module named 'chromadb'/);
  });
});
