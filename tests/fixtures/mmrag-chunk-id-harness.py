#!/usr/bin/env python3
"""Harness: drive mmrag's REAL ingest_text_file against a fake store.

No API calls and no Chroma. embed_content is replaced by a counter, so the
number we assert on is the number of embedding REQUESTS the change is about —
the binding constraint is requests, not dollars.

Expected values are derived from mmrag's OWN chunk_text at the config's real
parameters. An estimate here would make the comparison two guesses.

Emits one JSON object on stdout. Any failure raises, so a broken harness cannot
be read as a passing scenario.
"""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MMRAG = REPO / "knowledge-base" / "scripts" / "mmrag.py"

spec = importlib.util.spec_from_file_location("mmrag", MMRAG)
mmrag = importlib.util.module_from_spec(spec)
sys.modules["mmrag"] = mmrag
spec.loader.exec_module(mmrag)

CHUNK_SIZE = 1000
OVERLAP = 200
CONFIG = {"text_chunk_size": CHUNK_SIZE, "text_chunk_overlap": OVERLAP}


class FakeCollection:
    """Minimal Chroma stand-in. Records ids -> (document, metadata)."""

    def __init__(self):
        self.rows = {}
        self.deleted = []

    def get(self, ids=None, where=None, include=None):
        if ids is not None:
            found = [i for i in ids if i in self.rows]
            return {"ids": found,
                    "metadatas": [self.rows[i][1] for i in found],
                    "documents": [self.rows[i][0] for i in found]}
        items = list(self.rows.items())
        if where:
            items = [(i, v) for i, v in items
                     if all(v[1].get(k) == val for k, val in where.items())]
        return {"ids": [i for i, _ in items],
                "metadatas": [v[1] for _, v in items],
                "documents": [v[0] for _, v in items]}

    def upsert(self, ids, embeddings, documents, metadatas):
        for i, doc, meta in zip(ids, documents, metadatas):
            self.rows[i] = (doc, meta)

    def delete(self, ids):
        for i in ids:
            self.rows.pop(i, None)
            self.deleted.append(i)


class Counter:
    def __init__(self):
        self.n = 0

    def __call__(self, client, config, content, task_type="RETRIEVAL_DOCUMENT"):
        self.n += 1
        return [0.0] * 8


def chunks_of(path):
    text = Path(path).read_text(errors="replace")
    return mmrag.chunk_text(text, chunk_size=CHUNK_SIZE, overlap=OVERLAP)


def ingest(collection, path, force=False):
    counter = Counter()
    mmrag.embed_content = counter
    mmrag.args_force = force
    n = mmrag.ingest_text_file(None, CONFIG, collection, path)
    mmrag.args_force = False
    return {"embedded": counter.n, "returned": n}


def rows_for(collection, path):
    src = str(Path(path).resolve())
    return [i for i, (_doc, meta) in collection.rows.items() if meta.get("source") == src]


def main():
    scenario = sys.argv[1]
    workdir = Path(sys.argv[2])
    f = workdir / "doc.md"
    out = {"scenario": scenario}

    # A body long enough to produce several chunks at 1000/200.
    base = "\n".join(f"line {i} — some prose that takes up room in the chunk window." for i in range(120))
    f.write_text(base, encoding="utf-8")

    col = FakeCollection()
    first = ingest(col, f)
    out["first_embedded"] = first["embedded"]
    out["first_chunks"] = len(chunks_of(f))
    out["first_rows"] = len(rows_for(col, f))
    if out["first_chunks"] < 3:
        raise SystemExit(f"fixture too small to be a real test: {out['first_chunks']} chunks")

    if scenario == "unchanged":
        # File-set non-empty asserted above (first_chunks >= 3), so a zero here
        # cannot be a zero over an empty set.
        second = ingest(col, f)
        out["second_embedded"] = second["embedded"]
        out["rows_after"] = len(rows_for(col, f))

    elif scenario == "append":
        old = chunks_of(f)
        f.write_text(base + "\n" + "\n".join(f"appended line {i} with enough text to matter." for i in range(40)),
                     encoding="utf-8")
        new = chunks_of(f)
        # Expectation derived from the real chunker, not estimated: the chunks
        # whose TEXT is new. Position-keyed ids would re-embed every chunk from
        # the first changed index onward.
        out["expected_new"] = len([c for c in new if c not in set(old)])
        out["old_chunks"] = len(old)
        out["new_chunks"] = len(new)
        second = ingest(col, f)
        out["second_embedded"] = second["embedded"]
        out["rows_after"] = len(rows_for(col, f))

    elif scenario == "stale_same_index":
        # THE STALENESS MUTANT ARM. Edit the text INSIDE chunk 0 without
        # changing the chunk count. Under md5(path)+index the id is unchanged,
        # already_exists() reports it present, and the stale embedding survives
        # a successful ingest with no error anywhere.
        old = chunks_of(f)
        edited = base.replace("line 0 —", "line 0 REWRITTEN —", 1)
        f.write_text(edited, encoding="utf-8")
        new = chunks_of(f)
        out["old_chunks"] = len(old)
        out["new_chunks"] = len(new)
        out["chunk0_changed"] = old[0] != new[0]
        second = ingest(col, f)
        out["second_embedded"] = second["embedded"]
        out["chunk0_document_in_store"] = new[0] in [d for d, _m in col.rows.values()]
        out["stale_chunk0_still_present"] = old[0] in [d for d, _m in col.rows.values()]
        out["rows_after"] = len(rows_for(col, f))

    elif scenario == "force_unchanged":
        second = ingest(col, f, force=True)
        out["second_embedded"] = second["embedded"]
        out["rows_after"] = len(rows_for(col, f))

    elif scenario == "old_scheme_migration":
        # Pre-seed rows in the RETIRED id scheme for the same source, as an
        # existing store would hold them, then re-ingest.
        col2 = FakeCollection()
        src = str(f.resolve())
        legacy = []
        h = hashlib.md5(src.encode()).hexdigest()[:12]
        for i, chunk in enumerate(chunks_of(f)):
            lid = f"{h}_chunk{i}"
            legacy.append(lid)
            col2.rows[lid] = (chunk, {"source": src, "type": "text", "chunk_index": i})
        out["legacy_rows_before"] = len(legacy)
        res = ingest(col2, f)
        out["second_embedded"] = res["embedded"]
        out["legacy_rows_after"] = len([i for i in legacy if i in col2.rows])
        out["rows_after"] = len(rows_for(col2, f))

    else:
        raise SystemExit(f"unknown scenario: {scenario}")

    print(json.dumps(out))


if __name__ == "__main__":
    main()
