import { describe, it, expect } from 'vitest';
import { parseIngestSummary } from '../../../src/bus/knowledge-base.js';

/**
 * `kb-ingest` printed "Done!" and exited 0 on every path: a successful ingest, a
 * 429 RESOURCE_EXHAUSTED, and a nonexistent source were indistinguishable to any
 * caller. Measured consequence on this fleet 2026-09-03: a day of memories never
 * reached the KB while every heartbeat reported success, and later queries
 * answered confidently out of stale August documents.
 *
 * The parser is the load-bearing piece, because the exit code alone was the lie.
 */

const SUCCESS = `Ingesting into collection: agent-city
  Source: ./MEMORY.md

Done! Ingested 58 new chunk(s) into 'agent-city'
  Tokens: 20,332 embedding | Cost: $0.0041`;

const WITH_ERRORS = `Ingesting into collection: agent-city
  ERROR: 429 RESOURCE_EXHAUSTED

Done! Ingested 0 new chunk(s) into 'agent-city'
  Errors: 3`;

const NOTHING_TO_DO = `Done! Ingested 0 new chunk(s) into 'agent-city'
  Skipped: 12 (already existed or empty)`;

describe('parseIngestSummary reads the tool instead of trusting it', () => {
  it('reads the count out of a successful run', () => {
    const r = parseIngestSummary(SUCCESS);
    expect(r.ingested).toBe(58);
    expect(r.errors).toBe(0);
  });

  it('reads the error count from a quota failure that still printed Done!', () => {
    // The exact shape of the bug: "Done!" present, exit code 0, nothing ingested.
    const r = parseIngestSummary(WITH_ERRORS);
    expect(r.ingested).toBe(0);
    expect(r.errors).toBe(3);
  });

  it('counts NOT FOUND sources as errors, not as a quiet zero', () => {
    const r = parseIngestSummary(`Done! Ingested 0 new chunk(s) into 'c'\n  Missing: 2`);
    expect(r.errors).toBe(2);
  });

  it('separates "nothing new to do" from "nothing worked"', () => {
    // 0 ingested with everything skipped is a legitimate no-op: the documents
    // were already indexed. Treating it as failure would make every second
    // heartbeat report an error.
    const r = parseIngestSummary(NOTHING_TO_DO);
    expect(r.ingested).toBe(0);
    expect(r.skipped).toBe(12);
    expect(r.errors).toBe(0);
  });

  it('returns null — not zero — when the summary line is absent', () => {
    // "Could not parse" and "parsed as zero" are different answers, and
    // collapsing them is how an unverifiable run gets reported as a clean one.
    const r = parseIngestSummary('some unrelated output\ntraceback...');
    expect(r.ingested, 'unparseable must not read as 0').toBeNull();
    expect(r.errors, 'no basis to claim zero errors either').toBeNull();
  });

  it('returns null on empty output rather than claiming a clean run', () => {
    const r = parseIngestSummary('');
    expect(r.ingested).toBeNull();
  });

  it('does not mistake a similar sentence elsewhere for the summary', () => {
    // Negative control on the regex itself: prose mentioning ingestion must not
    // satisfy the parser, or the parser proves nothing.
    const r = parseIngestSummary('We should have Ingested more chunks today.');
    expect(r.ingested).toBeNull();
  });

  // REGRESSION — a correct no-op must not read as a failure.
  //
  // mmrag increments `skipped` ONLY in its directory branch, so re-ingesting a single
  // already-complete FILE yields total=0 AND skipped=0. An exit rule keyed on `skipped`
  // therefore calls a correct no-op a failure, which would have made a fleet-wide
  // re-ingest report failure on every seat whose memory was already indexed — the exact
  // inverse of the defect this suite exists to catch. Measured live before the fix: rc=1.
  it('an already-present file is handled, not failed', () => {
    const out = [
      'Ingesting: 2026-09-03.md',
      '  Already present (0 new chunk(s))',
      '',
      "Done! Ingested 0 new chunk(s) into 'agent-city'",
    ].join('\n');
    const parsed = parseIngestSummary(out);
    expect(parsed.ingested).toBe(0);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].status).toBe('already-present');
    expect(parsed.files[0].name).toBe('2026-09-03.md');
  });

  // POSITIVE CONTROL for the line above: a source announced and then NOT resolved is still
  // a failure. Without this, "treat unresolved as fine" would satisfy the test above.
  it('a source announced but never resolved is still failed', () => {
    const parsed = parseIngestSummary(
      ["Ingesting: ghost.md", "", "Done! Ingested 0 new chunk(s) into 'agent-city'"].join('\n'),
    );
    expect(parsed.files[0].status).toBe('failed');
  });

  // THE #7/#9 SEAM. PR #9 prints these markers as f"{indent}..." — the indent becomes a
  // variable on the OTHER side of this boundary. An `^\s+` anchor works only while every
  // call site passes a non-empty indent, and nothing asserted that. A caller passing '' would
  // not error: the line would simply stop being recognised and an already-present file would
  // be misread as FAILED. Pinned across every indent the printer can produce, including none.
  for (const indent of ['', ' ', '  ', '    ', '\t']) {
    it(`recognises per-file markers with indent ${JSON.stringify(indent)}`, () => {
      const added = parseIngestSummary(
        [`Ingesting: a.md`, `${indent}Added 5 chunk(s)`, "Done! Ingested 5 new chunk(s) into 'c'"].join('\n'),
      );
      expect(added.files[0]).toEqual({ name: 'a.md', status: 'added', chunks: 5 });

      const present = parseIngestSummary(
        [`Ingesting: b.md`, `${indent}Already present (0 new chunk(s))`, "Done! Ingested 0 new chunk(s) into 'c'"].join('\n'),
      );
      expect(present.files[0].status).toBe('already-present');

      const failed = parseIngestSummary(
        [`Ingesting: c.md`, `${indent}ERROR: 429 RESOURCE_EXHAUSTED`, "Done! Ingested 0 new chunk(s) into 'c'"].join('\n'),
      );
      expect(failed.files[0].status).toBe('failed');
    });
  }

  // NEGATIVE CONTROL for the tolerant anchor: a column-0 "ERROR:" with NO file announced
  // must not be attributed to anything. mmrag prints exactly that for a missing config,
  // before any "Ingesting:" line — so tolerance must not become promiscuity.
  it('a column-0 ERROR with no pending source is attributed to nothing', () => {
    const parsed = parseIngestSummary('ERROR: Config not found. Run setup first:');
    expect(parsed.files).toEqual([]);
  });
});
