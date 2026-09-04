import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Text chunk ids used to be md5(path) + "_chunk{i}" — keyed on the chunk's
 * POSITION, never on its text. An edit re-flows every following chunk across
 * the 200-byte overlap, so chunk k's CONTENT changes while its id does not, and
 * already_exists() then reports the stale embedding as present. The failure is
 * raised by a SUCCESSFUL ingest: no error, no exit code, no clue.
 *
 * These run mmrag's REAL ingest_text_file against a fake store with
 * embed_content replaced by a counter, so the asserted number is the number of
 * embedding REQUESTS — the binding constraint here is requests, not dollars.
 * Expected values come from mmrag's OWN chunk_text at the real parameters; an
 * estimate would make the comparison two guesses.
 */

const ROOT = join(__dirname, '..', '..', '..');
const HARNESS = join(ROOT, 'tests', 'fixtures', 'mmrag-chunk-id-harness.py');
const MMRAG = join(ROOT, 'knowledge-base', 'scripts', 'mmrag.py');

let dir: string;

function run(scenario: string, harness = HARNESS): any {
  const work = mkdtempSync(join(dir, 'w-'));
  const out = execFileSync('python3', [harness, scenario, work], { encoding: 'utf-8' });
  return JSON.parse(out);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mmrag-ids-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('mmrag text chunk ids are content-addressed', () => {
  it('an unchanged file re-embeds ZERO', () => {
    const r = run('unchanged');
    // Non-empty file set asserted explicitly, so a zero here cannot be a zero
    // over an empty set — that reads identically and means nothing.
    expect(r.first_chunks).toBeGreaterThanOrEqual(3);
    expect(r.first_embedded).toBe(r.first_chunks);
    expect(r.second_embedded).toBe(0);
    expect(r.rows_after).toBe(r.first_chunks);
  });

  it('an append re-embeds only the new and re-flowed chunks', () => {
    const r = run('append');
    expect(r.new_chunks).toBeGreaterThan(r.old_chunks);
    // expected_new is derived from the real chunker: the chunks whose TEXT is
    // new. It is strictly fewer than a full re-embed, and strictly more than
    // "just the appended ones" — the difference is the re-flowed chunk that the
    // position-keyed scheme silently left stale.
    expect(r.second_embedded).toBe(r.expected_new);
    expect(r.second_embedded).toBeLessThan(r.new_chunks);
    expect(r.rows_after).toBe(r.new_chunks);
  });

  it('a chunk whose text changed under the SAME index IS re-embedded', () => {
    const r = run('stale_same_index');
    expect(r.old_chunks).toBe(r.new_chunks); // the index is genuinely unchanged
    expect(r.chunk0_changed).toBe(true);
    expect(r.second_embedded).toBeGreaterThanOrEqual(1);
    expect(r.chunk0_document_in_store).toBe(true);
    expect(r.stale_chunk0_still_present).toBe(false);
  });

  it('leaves no orphaned rows after an edit', () => {
    const edit = run('stale_same_index');
    expect(edit.rows_after).toBe(edit.new_chunks);
    const appended = run('append');
    // Content ids mean an edited chunk lands under a NEW id and does NOT
    // overwrite the old row. Without the sweep the store would hold both the
    // stale text and the fresh text, and both would answer queries — strictly
    // worse than the position-keyed behaviour it replaces.
    expect(appended.rows_after).toBe(appended.new_chunks);
  });

  it('removes retired md5(path)+index rows on the first re-ingest (no migration script)', () => {
    const r = run('old_scheme_migration');
    expect(r.legacy_rows_before).toBe(r.first_chunks);
    expect(r.legacy_rows_after).toBe(0);
    // One-time cost: every chunk re-embeds once as its id changes scheme.
    expect(r.second_embedded).toBe(r.first_chunks);
    expect(r.rows_after).toBe(r.first_chunks);
  });

  it('--force still re-embeds EVERYTHING (the flag keeps its meaning)', () => {
    // Ruled deliberately. Media ids (image/video/audio/pdf) remain path-keyed
    // and content-independent, so --force is the ONLY way to refresh an edited
    // media file; and it is the only escape hatch if the embedding model
    // changes, which no content hash can notice. Making it a no-op would remove
    // the sole repair path for four of the five ingest types.
    const r = run('force_unchanged');
    expect(r.second_embedded).toBe(r.first_chunks);
  });

  it('MUST-FAIL ARM: reverting to position-keyed ids reproduces the stale chunk', () => {
    // The negative control is the instrument. Without this arm, every
    // assertion above is equally consistent with a harness that cannot fail.
    const mut = join(dir, 'mutant');
    mkdirSync(join(mut, 'knowledge-base', 'scripts'), { recursive: true });
    mkdirSync(join(mut, 'tests', 'fixtures'), { recursive: true });
    const src = readFileSync(MMRAG, 'utf-8');
    const NEEDLE = '    current_ids = [text_chunk_id(source, chunk) for chunk in chunks]';
    expect(src).toContain(NEEDLE); // the mutation must actually apply
    writeFileSync(
      join(mut, 'knowledge-base', 'scripts', 'mmrag.py'),
      src.replace(NEEDLE, '    current_ids = [file_id(file_path, i) for i, _c in enumerate(chunks)]'),
      'utf-8',
    );
    const mutHarness = join(mut, 'tests', 'fixtures', 'mmrag-chunk-id-harness.py');
    writeFileSync(mutHarness, readFileSync(HARNESS, 'utf-8'), 'utf-8');

    const r = run('stale_same_index', mutHarness);
    expect(r.chunk0_changed).toBe(true);
    expect(r.second_embedded).toBe(0);                 // a successful ingest that did nothing
    expect(r.stale_chunk0_still_present).toBe(true);   // the stale text survives
    expect(r.chunk0_document_in_store).toBe(false);    // the new text never lands

    // And the contrast that explains why the old scheme LOOKED cheaper: on an
    // append it embeds fewer chunks than the fix, because it is skipping the
    // re-flowed chunk it should have re-embedded.
    const a = run('append', mutHarness);
    const fixed = run('append');
    expect(a.second_embedded).toBeLessThan(fixed.second_embedded);
  });
});
