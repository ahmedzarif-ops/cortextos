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
});
