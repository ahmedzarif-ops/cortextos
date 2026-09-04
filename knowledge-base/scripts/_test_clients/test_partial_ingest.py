"""Behavioral tests for the partial-chunk accounting in mmrag.cmd_ingest.

Run from knowledge-base/scripts:

    python -m _test_clients.test_partial_ingest

THE DEFECT UNDER TEST (city 8j1dj, 2026-09-04)
----------------------------------------------
`count` is a local inside the ingest handler, incremented AFTER `collection.upsert`. On a
mid-file 429 the handler unwinds, `count` never returns, and `total += count` never runs — so
chunks that ARE in the store are reported as 0 added / 1 error. The ingest under-reports and
`list` disagrees with it, which is how a seat concludes "nothing landed" about a file that is
now HALF PRESENT and answering queries.

THE ASSERTION THAT DEFINES THIS FIX (chief): the count the ingest REPORTS must equal the delta
`list` SHOWS, under a mid-file failure. Not "a number is printed" — the two instruments an
operator actually reads must agree.

WHY A FAKE COLLECTION AND NOT A REAL ONE: the property is about accounting across a raise, not
about chromadb. A real store would make the test slow, machine-dependent, and — because it would
need real embeddings — dependent on the very API whose failure is being simulated.
"""

import os
import sys
import tempfile
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag

FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


class FakeCollection:
    """Minimal in-memory stand-in for a chroma collection.

    Implements only what mmrag touches: upsert, get(ids=...) and get(include=["metadatas"]).
    `list_counts()` re-derives per-source counts through mmrag.chunks_by_source — THE SAME
    function cmd_list renders — so "what list would show" is not re-implemented here.
    """

    def __init__(self):
        self.ids = []
        self.metadatas = []

    def upsert(self, ids=None, embeddings=None, documents=None, metadatas=None):
        for i, doc_id in enumerate(ids):
            if doc_id in self.ids:
                continue
            self.ids.append(doc_id)
            self.metadatas.append(metadatas[i])

    def get(self, ids=None, include=None):
        if ids is not None:
            found = [i for i in ids if i in self.ids]
            return {"ids": found, "metadatas": []}
        return {"ids": list(self.ids), "metadatas": list(self.metadatas)}

    def list_counts(self):
        by_source, total = mmrag.chunks_by_source(self)
        return by_source, total


class _Args:
    def __init__(self, paths, collection="test-col", force=False):
        self.paths = paths
        self.collection = collection
        self.force = force


def _install(monkey, collection, fail_on_call=None):
    """Point mmrag's collaborators at fakes. Returns a dict of call counters.

    fail_on_call: 1-based index of the embed_content call that raises a 429. None = never.
    """
    state = {"embed_calls": 0}
    real = {}

    for name in ("load_config", "get_genai_client", "get_api_key", "get_chroma_collection",
                 "embed_content"):
        real[name] = getattr(mmrag, name)

    from _test_clients.fault_injection import _InjectedAPIError

    def fake_embed(client, config, content, task_type="RETRIEVAL_DOCUMENT"):
        state["embed_calls"] += 1
        if fail_on_call is not None and state["embed_calls"] == fail_on_call:
            raise _InjectedAPIError(429, "RESOURCE_EXHAUSTED", "injected mid-file quota error")
        return [0.0] * 8

    mmrag.load_config = lambda: {"text_chunk_size": 100, "text_chunk_overlap": 0,
                                 "default_collection": "test-col"}
    mmrag.get_api_key = lambda config: "test-key"
    mmrag.get_genai_client = lambda key: object()
    mmrag.get_chroma_collection = lambda name: collection
    mmrag.embed_content = fake_embed

    monkey.append((real, state))
    return state


def _restore(monkey):
    for real, _ in monkey:
        for name, fn in real.items():
            setattr(mmrag, name, fn)


def _write_file(dirpath, name, n_chunks, chunk_size=100):
    """A file that chunks into exactly n_chunks pieces at chunk_size with zero overlap."""
    p = Path(dirpath) / name
    p.write_text(("x" * chunk_size) * n_chunks)
    return p


# ---------------------------------------------------------------------------

def test_partial_is_reported_and_matches_list():
    print("\n[test 1/4] mid-file 429: reported count == list delta (THE defining assertion)")
    with tempfile.TemporaryDirectory() as d:
        f = _write_file(d, "memo.md", 10)
        col = FakeCollection()
        monkey = []
        try:
            # Fail on the 5th chunk: 4 land, then the file dies mid-way.
            _install(monkey, col, fail_on_call=5)
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = mmrag.cmd_ingest(_Args([str(f)]))
            out = buf.getvalue()
        finally:
            _restore(monkey)

        by_source, total_chunks = col.list_counts()
        src = str(f.resolve())
        list_delta = by_source.get(src, {}).get("chunks", 0)

        # PRECONDITION, asserted rather than assumed (rule 30): the mutation must actually have
        # produced a PARTIAL. If the fixture stopped exercising a mid-file failure — say chunking
        # changed and the file only ever made 3 chunks — every assertion below would pass
        # vacuously on a file that simply succeeded or simply failed.
        _check("PRECONDITION: the store holds a PARTIAL (0 < landed < 10)",
               0 < list_delta < 10, detail=f"list shows {list_delta} chunks for the file")

        reported = None
        for line in out.splitlines():
            if "Done! Ingested" in line:
                reported = int(line.split("Ingested")[1].split("new")[0].strip())

        _check("ingest REPORTED a count at all", reported is not None, detail=out[-300:])
        _check("REPORTED COUNT == LIST DELTA (%r vs %r)" % (reported, list_delta),
               reported == list_delta,
               detail="the two instruments an operator reads disagree — this is the bug")
        _check("the failed file is NAMED as partial, not hidden behind 'Errors: 1'",
               "PARTIAL" in out and "memo.md" in out, detail=out[-400:])
        _check("the error is still counted (a partial is not a success)",
               "Errors: 1" in out, detail=out[-300:])


def test_clean_run_still_agrees():
    print("\n[test 2/4] CONTROL: a clean run must ALSO agree — no failure anywhere")
    # Without this, 'reported == list delta' could be satisfied by always reporting the store
    # total and never reporting the ingest's own work.
    with tempfile.TemporaryDirectory() as d:
        f = _write_file(d, "clean.md", 6)
        col = FakeCollection()
        monkey = []
        try:
            _install(monkey, col, fail_on_call=None)
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                mmrag.cmd_ingest(_Args([str(f)]))
            out = buf.getvalue()
        finally:
            _restore(monkey)

        by_source, _ = col.list_counts()
        list_delta = by_source.get(str(f.resolve()), {}).get("chunks", 0)
        _check("PRECONDITION: nothing failed", "Errors:" not in out, detail=out[-200:])
        _check("all 6 chunks landed", list_delta == 6, detail=f"got {list_delta}")
        _check("reported == list delta on the happy path",
               "Ingested 6 new chunk(s)" in out, detail=out[-200:])
        _check("no PARTIAL section on a clean run", "PARTIAL" not in out, detail=out[-200:])


def test_total_zero_when_first_chunk_fails():
    print("\n[test 3/4] BOUNDARY: failure on the FIRST chunk is 0 landed, not 'unknown'")
    # The other side of the boundary. 0 is a real answer here and must not be confused with
    # 'could not tell' — those print differently on purpose.
    with tempfile.TemporaryDirectory() as d:
        f = _write_file(d, "dead.md", 5)
        col = FakeCollection()
        monkey = []
        try:
            _install(monkey, col, fail_on_call=1)
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                mmrag.cmd_ingest(_Args([str(f)]))
            out = buf.getvalue()
        finally:
            _restore(monkey)

        by_source, _ = col.list_counts()
        list_delta = by_source.get(str(f.resolve()), {}).get("chunks", 0)
        _check("nothing landed", list_delta == 0, detail=f"got {list_delta}")
        _check("reported 0, matching list", "Ingested 0 new chunk(s)" in out, detail=out[-200:])
        _check("0 landed is NOT announced as a partial document",
               "is now PARTIAL in the store" not in out, detail=out[-300:])
        _check("and NOT reported as an unknown count",
               "UNKNOWN" not in out, detail=out[-300:])


def test_skipped_counted_for_a_single_file():
    print("\n[test 4/4] a fully-present single file counts as SKIPPED, not as nothing")
    # `skipped` used to be incremented only in the DIRECTORY branch. A single already-present
    # file therefore gave total=0, skipped=0 — which any caller gating on 'did it do anything'
    # reads as failure, though the no-op is correct. This matters now because cortextos #7 makes
    # `total == 0 and skipped == 0 and paths_given` a NON-ZERO EXIT.
    with tempfile.TemporaryDirectory() as d:
        f = _write_file(d, "again.md", 4)
        col = FakeCollection()
        monkey = []
        try:
            _install(monkey, col, fail_on_call=None)
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                mmrag.cmd_ingest(_Args([str(f)]))       # first run: writes 4
                buf2 = io.StringIO()
                with contextlib.redirect_stdout(buf2):
                    mmrag.cmd_ingest(_Args([str(f)]))   # second run: nothing new
            out2 = buf2.getvalue()
        finally:
            _restore(monkey)

        _check("second run adds nothing", "Ingested 0 new chunk(s)" in out2, detail=out2[-200:])
        _check("and says SKIPPED rather than staying silent",
               "Skipped: 1" in out2, detail=out2[-300:])
        _check("a no-op re-ingest is not an error", "Errors:" not in out2, detail=out2[-200:])


def main():
    test_partial_is_reported_and_matches_list()
    test_clean_run_still_agrees()
    test_total_zero_when_first_chunk_fails()
    test_skipped_counted_for_a_single_file()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("ALL PASS (4 scenarios)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
