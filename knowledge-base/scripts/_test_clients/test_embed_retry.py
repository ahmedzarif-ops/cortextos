"""Behavioral tests for the EMBEDDING retry path (task_1788512896309_59094644).

Run from knowledge-base/scripts:

    python -m _test_clients.test_embed_retry

Exits 0 on all-pass, 1 on any failure.

WHY THIS FILE EXISTS AND test_retry.py DID NOT COVER IT:
mmrag had a correct, well-tested retry loop wired to exactly ONE call site —
ingest_pdf's generate_content. `embed_content` was raw, and it is the call every
markdown/memory ingest travels, plus every KB query via embed_query. The harness
even refused to script embeddings ("Tests should target _retry_generate_content
directly"), so the untested half was the unprotected half. A single transient 429
killed an ingest while the helper written to prevent that sat 200 lines away.

⭐ THE ASSERTIONS ARE ON THE CHUNK COUNT AND THE ATTEMPT COUNT, NOT ON rc.
An rc-only test passes a version that retries and silently drops the tail — which
is the failure this whole area is made of.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag
from _test_clients import fault_injection

FAILURES = []
CONFIG = {"embedding_model": "m", "embedding_dimensions": 8}


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


def _client(embed_script):
    return fault_injection.FaultInjectionClient(
        fault_injection._parse_script("200"),
        fault_injection._parse_script(embed_script),
    )


def test_embed_transient_then_success():
    print("\n[test 1/5] embed: 429 -> 429 -> 200 completes")
    os.environ["MMRAG_EMBED_BACKOFFS"] = "0,0,0"
    client = _client("429,429,200")
    vec = mmrag.embed_content(client, CONFIG, "some memory text")
    _check("returns an embedding after two transients", vec is not None)
    _check("embedding has the configured width", len(vec) == 8, detail=f"got {len(vec) if vec else None}")
    _check("consumed exactly 3 attempts", client.models.embed_calls == 3,
           detail=f"got {client.models.embed_calls}")


def test_embed_all_exhausted_raises():
    print("\n[test 2/5] embed: 429 x3 raises — LOUD, not a silent zero")
    os.environ["MMRAG_EMBED_BACKOFFS"] = "0,0,0"
    client = _client("429,429,429")
    raised = None
    try:
        mmrag.embed_content(client, CONFIG, "text")
    except Exception as e:  # noqa: BLE001 — the point is that SOMETHING escapes
        raised = e
    _check("raises after exhausting retries", raised is not None)
    _check("the escaping error is the injected 429",
           getattr(raised, "code", None) == 429, detail=f"got {getattr(raised, 'code', None)}")
    _check("consumed exactly 3 attempts (bounded, not unbounded)",
           client.models.embed_calls == 3, detail=f"got {client.models.embed_calls}")


def test_embed_fail_fast_nontransient():
    print("\n[test 3/5] embed: 403 fails fast — predicate is structural, not textual")
    os.environ["MMRAG_EMBED_BACKOFFS"] = "0,0,0"
    # Body mentions 429 on purpose: a textual predicate would retry this.
    client = _client("403:quota-ish wording mentioning 429,200")
    raised = None
    try:
        mmrag.embed_content(client, CONFIG, "text")
    except Exception as e:  # noqa: BLE001
        raised = e
    _check("raises immediately on non-transient", raised is not None)
    _check("raised.code is 403", getattr(raised, "code", None) == 403,
           detail=f"got {getattr(raised, 'code', None)}")
    _check("did NOT consume the second scripted attempt",
           client.models.embed_calls == 1, detail=f"got {client.models.embed_calls}")


def test_embed_query_is_covered_too():
    print("\n[test 4/5] embed_query retries as well — a blip must not block READING memory")
    os.environ["MMRAG_EMBED_BACKOFFS"] = "0,0,0"
    client = _client("429,200")
    vec = mmrag.embed_query(client, CONFIG, "what did the fleet learn")
    _check("query embedding survives a transient", vec is not None)
    _check("consumed exactly 2 attempts", client.models.embed_calls == 2,
           detail=f"got {client.models.embed_calls}")


def test_chunk_count_not_rc():
    print("\n[test 5/5] CHUNK COUNT: every chunk lands even when each one 429s once first")
    # THE ASSERTION CHIEF ASKED FOR. A version that retries the FIRST chunk and
    # gives up on the rest would still exit 0; only the count catches it.
    os.environ["MMRAG_EMBED_BACKOFFS"] = "0,0,0"
    chunks = ["alpha", "beta", "gamma", "delta"]
    script = ",".join(["429", "200"] * len(chunks))
    client = _client(script)
    # Catch per chunk: a dropped tail must print as a FAILED ASSERTION with the count,
    # not as a traceback. The assertion is the report (a test that dies is not a test
    # that told you what it found).
    vectors = []
    errors = []
    for c in chunks:
        try:
            vectors.append(mmrag.embed_content(client, CONFIG, c))
        except Exception as e:  # noqa: BLE001
            vectors.append(None)
            errors.append(f"{c}: {type(e).__name__}")
    _check("every chunk produced an embedding — none silently dropped",
           len(vectors) == len(chunks) and all(v is not None for v in vectors),
           detail=f"got {sum(1 for v in vectors if v is not None)}/{len(chunks)}; failures={errors}")
    _check("attempts == 2 per chunk (one retry each), not 2 total",
           client.models.embed_calls == 2 * len(chunks),
           detail=f"got {client.models.embed_calls}, expected {2 * len(chunks)}")


if __name__ == "__main__":
    test_embed_transient_then_success()
    test_embed_all_exhausted_raises()
    test_embed_fail_fast_nontransient()
    test_embed_query_is_covered_too()
    test_chunk_count_not_rc()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("ALL PASS (5 scenarios)")
    sys.exit(0)
