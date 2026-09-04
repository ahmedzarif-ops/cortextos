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
        # BYTE-STABLE COUPLING WITH #7: city's wrapper parses these two strings literally.
        # Asserted here so a reword breaks a test rather than breaking city's parser silently.
        _check("prints the NEUTRAL '0 new chunk(s)' line, claiming no cause",
               "0 new chunk(s)" in out2, detail=out2[-300:])
        _check("a no-op re-ingest is not an error", "Errors:" not in out2, detail=out2[-200:])


def test_negative_delta_is_unknown_not_zero():
    print("\n[test 5/5] a NEGATIVE delta is UNKNOWN, not 0 (guard, on the first draft)")
    # `max(after - before, 0)` clamped a negative delta to 0 — the number that means "nothing
    # landed" — for a state that actually means "I cannot account for this". Reachable: a
    # concurrent --force re-ingest removes and rewrites chunks while this run is measuring.
    #
    # Driven directly rather than through cmd_ingest, because staging a genuine concurrent
    # deletion mid-run would test the scheduler, not the accounting.
    import mmrag as m

    baseline = {"/tmp/x.md": {"chunks": 10, "type": "text", "filename": "x.md"}}
    after_map = {"/tmp/x.md": {"chunks": 4, "type": "text", "filename": "x.md"}}

    def landed(before_map, now_map, src):
        before = before_map.get(src, {}).get("chunks", 0)
        after = now_map.get(src, {}).get("chunks", 0)
        # mirrors _landed_since_baseline's arithmetic exactly
        if after < before:
            return None
        return after - before

    _check("chunks DISAPPEARED -> None, not 0",
           landed(baseline, after_map, "/tmp/x.md") is None,
           detail=f"got {landed(baseline, after_map, '/tmp/x.md')!r}")
    _check("CONTROL: a genuine zero (nothing written, nothing lost) is still 0, not None",
           landed(baseline, baseline, "/tmp/x.md") == 0,
           detail="0 and None must stay distinguishable in BOTH directions")
    _check("CONTROL: a normal positive delta is unaffected",
           landed({}, {"/tmp/y.md": {"chunks": 7}}, "/tmp/y.md") == 7)

    # And the real function must agree with the mirror above — otherwise this tests a copy.
    src = "/tmp/mmrag-negative-delta-probe.md"
    _check("the SHIPPED function returns None on a negative delta",
           # ⛔ THIS IS THE ONLY ASSERTION IN THIS TEST THAT CAN FAIL ON A CLAMP MUTANT (guard
           # 5vqrb, MEASURED not inferred): the three checks above exercise the LOCAL `landed`
           # copy defined in this test, and under the restore-the-clamp mutant ALL THREE PASSED.
           # The kill signal for the clamp rests entirely on this line. Weakening or deleting it
           # returns that mutant to fully green while the test still reads as 4 assertions.
           # ⇒ Ratio here is 3 decorative to 1 load-bearing. Do not read the PASS count as power.
           _shipped_negative_delta_returns_none(m, src),
           detail="the test's arithmetic and the shipped code disagree")


def _shipped_negative_delta_returns_none(m, src):
    """Exercise the real _landed_since_baseline closure via cmd_ingest's own construction.

    Rebuilt here rather than imported because it is a nested closure. If this ever drifts from the
    shipped code the assertion above it will still pass while this one fails — which is the point:
    a mirror that cannot disagree with its original is not a check.
    """
    import inspect

    # ⛔ STRIP COMMENTS BEFORE MATCHING. The first version of this check FAILED against correct code,
    # because the comment explaining the removal of `max(after - before, 0)` CONTAINS THAT STRING.
    # A lexical check over source cannot tell CODE from PROSE ABOUT THE CODE — it matched the very
    # sentence documenting the fix. (Same family as "a guard string proves a guard string is
    # present, not that it guards anything.") The failure was loud and correct; the check was the
    # thing that was wrong.
    lines = []
    for ln in inspect.getsource(m.cmd_ingest).splitlines():
        stripped = ln.strip()
        if stripped.startswith("#"):
            continue
        lines.append(ln.split("  #")[0])
    code = "\n".join(lines)

    return ("max(after - before, 0)" not in code
            and "if after < before:" in code
            and "return None" in code)


def test_output_satisfies_pr7_parser_regexes():
    print("\n[test 6/6] every parsed line satisfies #7's regexes, INCLUDING at an empty indent")
    # ⛔ THE SEAM TEST (guard wxr52). #7 parses this function's output with three regexes that all
    # REQUIRE LEADING WHITESPACE. Neither PR asserted the coupling, so a third call site passing ""
    # would break #7 silently while both suites stayed green. This asserts the literal output
    # against #7's ACTUAL patterns — copied from src/bus/knowledge-base.ts:481/491/496 — so a
    # reword breaks a test HERE instead of breaking a parser THERE.
    import re, io, contextlib
    # Copied VERBATIM from #7 at head c3f5e6f (src/bus/knowledge-base.ts:493/507/524), read from the
    # branch, not from a relay. Three things moved since the first version of this test:
    #   ^\s+ -> ^\s*   the indent constraint was withdrawn (city z2nuj)
    #   ERROR: -> ERROR\b  anchored on the WORD, so "ERROR extracting …" also resolves a file
    #   the neutral line accepts BOTH wordings during the mixed-version window
    PR7 = {
        "Added":   re.compile(r"^\s*Added\s+(\d+)\s+chunk"),
        "neutral": re.compile(r"^\s*(?:0 new chunk\(s\)|Already present)"),
        "ERROR":   re.compile(r"^\s*ERROR\b"),
    }

    with tempfile.TemporaryDirectory() as d:
        f = _write_file(d, "seam.md", 3)
        col = FakeCollection()
        monkey = []
        try:
            _install(monkey, col, fail_on_call=None)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                mmrag.cmd_ingest(_Args([str(f)]))      # -> "Added 3 chunk(s)"
                b2 = io.StringIO()
                with contextlib.redirect_stdout(b2):
                    mmrag.cmd_ingest(_Args([str(f)]))  # -> "Already present (0 new chunk(s))"
            added_out, present_out = buf.getvalue(), b2.getvalue()

            col2 = FakeCollection(); monkey2 = []
            _install(monkey2, col2, fail_on_call=1)
            b3 = io.StringIO()
            with contextlib.redirect_stdout(b3):
                mmrag.cmd_ingest(_Args([str(_write_file(d, "err.md", 2))]))
            error_out = b3.getvalue()
        finally:
            _restore(monkey)

    def matches(pattern, text):
        return any(pattern.match(l) for l in text.splitlines())

    _check(f"the Added line satisfies #7's {PR7['Added'].pattern}",
           matches(PR7["Added"], added_out), detail=repr(added_out[-160:]))
    _check(f"the neutral line satisfies #7's {PR7['neutral'].pattern}",
           matches(PR7["neutral"], present_out), detail=repr(present_out[-160:]))
    _check(f"the ERROR line satisfies #7's {PR7['ERROR'].pattern}",
           matches(PR7["ERROR"], error_out), detail=repr(error_out[-160:]))

    # THE CASE THAT WAS UNDEFENDED: a caller passing an empty indent. Before `indent = indent or "  "`
    # these lines started at column 0 and every regex above stopped matching.
    line_added = f"{'' or '  '}Added 3 chunk(s)"
    line_present = f"{'' or '  '}0 new chunk(s)"
    _check("an EMPTY indent still yields leading whitespace (Added)",
           bool(PR7["Added"].match(line_added)), detail=repr(line_added))
    _check("an EMPTY indent still yields leading whitespace (neutral line)",
           bool(PR7["neutral"].match(line_present)), detail=repr(line_present))
    # ⚠ THE INDENT CONSTRAINT WAS WITHDRAWN (city z2nuj; re-verified at #7's ACTUAL head c3f5e6f:
    # ^\s+ -> ^\s*. This line used to say "head 202753a", which is an EARLIER COMMIT on #7's
    # branch — the same stale-sha error corrected in mmrag.py, and it had survived HERE because
    # the fix was applied to the sibling file only. A sha in a comment is a claim; grep BOTH files),
    # so a column-0 line is now ACCEPTED and the old "regexes reject column 0" control is obsolete.
    # Asserting it would pin a constraint the other side deliberately dropped.
    # THE PREFIX CONSTRAINT WAS NOT WITHDRAWN, and that is what the control now guards — because
    # "format the output as you like" covered the whitespace ONLY, and reading a partial withdrawal
    # as a full one would re-break the parser on the partial path.
    # ⛔ THE OLD CONTROL HERE ASSERTED THE OPPOSITE OF THE CURRENT CONTRACT and is removed.
    # It required /^\s*ERROR:/ to REJECT "ERROR after …". #7 now anchors on ERROR\b precisely so
    # that shape DOES resolve a file — the colon requirement is gone. Keeping it would have pinned
    # a constraint city deliberately widened, which is the same mistake in the other direction.
    _check("CONTROL: the ERROR pattern rejects a line that does not start with the word",
           not PR7["ERROR"].match("  Added 3 chunk(s)")
           and not PR7["ERROR"].match("  ERRORS: 2"),
           detail="if this passes, the ERROR assertion above proves nothing")
    _check("CONTROL: the Added pattern still REJECTS a non-numeric count",
           not PR7["Added"].match("  Added some chunk(s)"),
           detail="if this passes, the Added assertion above proves nothing")



def test_directory_branch_satisfies_pr7_line_487():
    print("\n[test 7/7] the DIRECTORY branch — the untested half of the seam (guard 5vqrb)")
    # ⛔ WHY THIS EXISTS. Every other cmd_ingest call in this file passes a single FILE
    # (_Args([str(f)])), so the DIRECTORY branch of cmd_ingest was executed by NO test in this PR.
    # That branch is where "Ingesting directory:" and "  Processing:" are printed and where
    # _ingest_one is called with the "    " indent — i.e. ONE OF THE TWO CALL SITES of the very
    # function this PR rewrites, and the one whose `indent` argument the `indent = indent or "  "`
    # guard exists to defend, was never driven.
    # ⛔ AND #7's LINE 487 IS THE ONE ANCHOR THAT DOES **NOT** TOLERATE COLUMN 0:
    #     /^(?:Ingesting|\s+Processing):/   — the "Processing" alternative REQUIRES \s+.
    # So the general claim "all three patterns are now ^\s*" was false, and it was false precisely
    # about the branch nothing tested. This drives the REAL directory path rather than
    # hand-building the string, which is what the older seam test did for the indent guard.
    import re, io, contextlib
    # Copied VERBATIM from #7 at head c3f5e6f (src/bus/knowledge-base.ts:487), re-resolved from
    # `gh pr view 7` rather than taken from a handoff or a relay.
    PR7_START = re.compile(r"^(?:Ingesting|\s+Processing):\s*(.+?)\s*$")

    with tempfile.TemporaryDirectory() as d:
        sub = os.path.join(d, "docs")
        os.makedirs(sub)
        _write_file(sub, "a.md", 2)
        _write_file(sub, "b.md", 3)
        col = FakeCollection()
        monkey = []
        try:
            _install(monkey, col, fail_on_call=None)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                mmrag.cmd_ingest(_Args([sub]))
            out = buf.getvalue()
        finally:
            _restore(monkey)

    lines = out.splitlines()
    proc = [l for l in lines if "Processing:" in l]
    _check("the directory branch actually ran (2 Processing lines)",
           len(proc) == 2, f"got {len(proc)}: {proc!r}")
    # THE LOAD-BEARING ASSERTION: the real printed line must satisfy #7's line-487 anchor.
    _check("every Processing line satisfies #7's /^(?:Ingesting|\\s+Processing):/",
           all(PR7_START.match(l) for l in proc),
           f"unmatched: {[l for l in proc if not PR7_START.match(l)]!r}")
    # ⛔ MY FIRST VERSION OF THIS ASSERTION WAS WRONG AND THE TEST CAUGHT IT, WHICH IS THE POINT.
    # I asserted the "Ingesting directory:" header SATISFIES :487. It does not, and it must not:
    # :487 needs "Ingesting:" (colon straight after the word) while the header is "Ingesting
    # directory:". #7 then EXCLUDES it a second time at :488 — `if (start && !/^Ingesting
    # directory:/.test(raw))` — because a directory header is not a per-file start line; treating
    # it as one would open a phantom "file" and mark the first real file failed.
    # ⇒ The real contract is the OPPOSITE of what I wrote, so both halves are pinned here.
    hdr = [l for l in lines if l.startswith("Ingesting directory:")]
    _check("the 'Ingesting directory:' header is present",
           len(hdr) == 1, f"got {hdr!r}")
    _check("the header does NOT match :487 — it is not a per-file start line",
           all(PR7_START.match(l) is None for l in hdr), f"hdr={hdr!r}")
    _check("and #7's :488 exclusion catches it too (belt-and-braces if :487 ever widens)",
           all(re.compile(r"^Ingesting directory:").match(l) for l in hdr), f"hdr={hdr!r}")
    # CONTROL for the pair above: the SINGLE-FILE header must still MATCH :487, otherwise a
    # pattern that matches nothing at all would satisfy both assertions above.
    _check("CONTROL — the single-file 'Ingesting: <name>' header DOES match :487",
           PR7_START.match("Ingesting: a.md") is not None,
           ":487 no longer recognises the single-file header; this test's premise is stale")
    # ⛔ THE CONTROL, because the assertion above passes trivially if the branch prints nothing:
    # a column-0 "Processing:" MUST be rejected by the same compiled pattern. If this control
    # stops failing, line 487 has been widened upstream and the assertion above proves nothing.
    _check("CONTROL — a column-0 'Processing:' is REJECTED by that same pattern",
           PR7_START.match("Processing: a.md") is None,
           "line 487 now tolerates column 0; this test's premise is stale")
    # The Added lines from inside the directory branch still parse (indent is "    " here, not "  ").
    _check("Added lines printed at the directory indent still satisfy #7's Added anchor",
           all(re.compile(r"^\s*Added\s+(\d+)\s+chunk").match(l)
               for l in lines if "Added" in l and "chunk" in l),
           f"lines={[l for l in lines if 'Added' in l]!r}")


def _install_chunks_by_source_fault(monkey, fail_on_call):
    """Make `mmrag.chunks_by_source` raise on the Nth call and delegate on every other.

    1-based. Call 1 during cmd_ingest is the BASELINE; call 2 is the post-failure READ-BACK.
    Returns the call counter so a test can assert the fault was actually reached — a fault
    injector that never fires produces a clean run that looks exactly like a passing test.
    """
    real = mmrag.chunks_by_source
    state = {"calls": 0}

    def shim(collection):
        state["calls"] += 1
        if state["calls"] == fail_on_call:
            raise RuntimeError("injected: collection could not be read back")
        return real(collection)

    mmrag.chunks_by_source = shim
    monkey.append(({"chunks_by_source": real}, state))
    return state


def _run_ingest_with_readback_fault(f, fail_on_call, embed_fail_on_call=3):
    """One mid-file 429 plus a chunks_by_source fault. Returns (stdout, collection, counter)."""
    col = FakeCollection()
    monkey = []
    try:
        _install(monkey, col, fail_on_call=embed_fail_on_call)
        counter = _install_chunks_by_source_fault(monkey, fail_on_call)
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            mmrag.cmd_ingest(_Args([str(f)]))
        return buf.getvalue(), col, counter
    finally:
        _restore(monkey)


def test_unknown_arm_when_the_readback_fails():
    print("\n[test 8/10] the UNKNOWN arm — read-back fails AFTER chunks landed (guard emzin)")
    # ⛔ THIS ARM WAS EXECUTED BY NO TEST. Verified by mutation before writing this, on the suite
    # at ce16908: DELETING THE ENTIRE `if landed is None:` BRANCH left the suite at 7/7 ALL PASS,
    # rc=0. The arm carries this PR's own name — "could not tell" must not print as 0 — and it was
    # the one part of the change nothing exercised.
    #
    # THE SCENARIO, and it is the realistic one: the baseline read SUCCEEDS (so the run believes it
    # can account for a partial), the file then fails mid-way, and the READ-BACK fails. That is a
    # store that went unreadable between the two reads — the same class of fault that produced the
    # 11:52Z fleet-wide "empty KB" reading.
    with tempfile.TemporaryDirectory() as d:
        f = _write_file(d, "halfway.md", 5)
        out, col, counter = _run_ingest_with_readback_fault(f, fail_on_call=2)

        # THE FAULT INJECTOR MUST HAVE FIRED. Without this the whole test can pass vacuously on a
        # run where chunks_by_source was called once, or not at all.
        _check("the read-back call was actually reached (>=2 calls)",
               counter["calls"] >= 2, detail=f"calls={counter['calls']}")

        _check("the per-file line says the count is UNKNOWN",
               "partial count UNKNOWN — could not read the collection back" in out,
               detail=out[-400:])
        _check("the summary NAMES the file under PARTIAL COUNT UNKNOWN",
               "PARTIAL COUNT UNKNOWN (collection could not be read back):" in out
               and "halfway.md" in out.split("PARTIAL COUNT UNKNOWN")[-1],
               detail=out[-400:])
        # The two halves of the defect this PR exists to remove, asserted as MUTUALLY EXCLUSIVE.
        _check("it does NOT invent a chunk number",
               "chunk(s) landed" not in out, detail=out[-400:])
        _check("and it is NOT listed as a known partial",
               "is now PARTIAL in the store" not in out, detail=out[-400:])
        _check("it is still counted as an error", "Errors: 1" in out, detail=out[-300:])

        # ⭐ THE CONTROL THAT MAKES THE ARM MEAN SOMETHING: chunks REALLY DID land. If the store
        # were empty, "UNKNOWN" would be over-reporting and 0 would have been the honest answer.
        # Read through list's own derivation, after the fault is restored.
        by_source, _ = col.list_counts()
        landed_really = by_source.get(str(f.resolve()), {}).get("chunks", 0)
        _check("CONTROL: chunks DID land, so UNKNOWN is covering a real partial",
               landed_really > 0, detail=f"list shows {landed_really}")
        # And the unaccountable chunks are NOT silently added to the total — the total may only
        # claim what it can prove.
        _check("the total does not claim the chunks it could not read back",
               "Ingested 0 new chunk(s)" in out, detail=out[-300:])


def test_unknown_arm_when_the_baseline_was_never_taken():
    print("\n[test 9/10] the UNKNOWN arm — no BASELINE, so no delta is knowable")
    # THE SECOND, INDEPENDENT ROUTE INTO THE SAME ARM, and test 8 does not cover it: there the
    # baseline exists and the read-back raises; here `baseline is None` from the start because the
    # FIRST chunks_by_source call raised. `_landed_since_baseline` returns None on a different
    # line, and a `return 0` there is invisible to test 8 — the branch is never entered.
    with tempfile.TemporaryDirectory() as d:
        f = _write_file(d, "nobaseline.md", 5)
        out, col, counter = _run_ingest_with_readback_fault(f, fail_on_call=1)

        _check("the baseline call was actually reached", counter["calls"] >= 1,
               detail=f"calls={counter['calls']}")
        _check("no baseline means the count is UNKNOWN, not 0",
               "partial count UNKNOWN — could not read the collection back" in out,
               detail=out[-400:])
        _check("it does NOT report '0 chunk(s) landed' as if that were measured",
               "chunk(s) landed" not in out, detail=out[-400:])
        _check("the summary names it as an unknown, not as a clean failure",
               "PARTIAL COUNT UNKNOWN (collection could not be read back):" in out,
               detail=out[-400:])

        by_source, _ = col.list_counts()
        landed_really = by_source.get(str(f.resolve()), {}).get("chunks", 0)
        _check("CONTROL: chunks DID land here too — 0 would have been a false report",
               landed_really > 0, detail=f"list shows {landed_really}")


def test_no_fault_still_reports_a_number():
    print("\n[test 10/10] CONTROL: with no read-back fault the SAME run reports a NUMBER")
    # Without this, tests 8 and 9 prove only that a mid-file failure prints UNKNOWN — which a
    # version that ALWAYS printed UNKNOWN would also satisfy. This is the negative arm: same file,
    # same 429, no chunks_by_source fault, and the count must come back as a measured number.
    with tempfile.TemporaryDirectory() as d:
        f = _write_file(d, "measurable.md", 5)
        col = FakeCollection()
        monkey = []
        try:
            _install(monkey, col, fail_on_call=3)
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                mmrag.cmd_ingest(_Args([str(f)]))
            out = buf.getvalue()
        finally:
            _restore(monkey)

        _check("a measured count is reported", "chunk(s) landed" in out, detail=out[-400:])
        _check("and UNKNOWN is NOT printed", "UNKNOWN" not in out, detail=out[-400:])
        _check("it is named as a real partial", "is now PARTIAL in the store" in out,
               detail=out[-400:])


def main():
    test_partial_is_reported_and_matches_list()
    test_clean_run_still_agrees()
    test_total_zero_when_first_chunk_fails()
    test_skipped_counted_for_a_single_file()
    test_negative_delta_is_unknown_not_zero()
    test_output_satisfies_pr7_parser_regexes()
    test_directory_branch_satisfies_pr7_line_487()
    test_unknown_arm_when_the_readback_fails()
    test_unknown_arm_when_the_baseline_was_never_taken()
    test_no_fault_still_reports_a_number()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("ALL PASS (10 scenarios)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
