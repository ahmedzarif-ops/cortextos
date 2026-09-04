#!/usr/bin/env python3
"""
Generate knowledge-digest.md — a BOOT-SIZED INDEX of knowledge.md.

WHY THIS EXISTS. knowledge.md is 551 KB. A Codex seat has a 258,400-token window;
reading knowledge.md at boot spends most of it before the seat has done anything.
The fix is not to shrink the knowledge — it is to stop reading it whole.

WHAT THE DIGEST IS. Titles plus ADDRESSES, nothing else. Every entry carries the
line range that holds its body, so a seat reads ONE rule with `sed -n 'A,Bp'`
instead of loading the file. An index of titles is discoverable at ~4% of the cost.

⛔ THIS IS A GENERATOR, NOT A HAND-MAINTAINED FILE. A digest edited by hand goes
stale silently and then lies about what the corpus contains — the same defect as a
hand-maintained count. Regenerate; never patch the output.

Usage:  python3 tools/make-knowledge-digest.py [--check]
        --check  exits 3 if the on-disk digest differs from a fresh generation
                 (for a cron or a pre-commit gate), 0 if identical.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "knowledge.md"
OUT = ROOT / "knowledge-digest.md"
TITLE_MAX = 96

SECTION = re.compile(r"^## (.+)$")
RULE = re.compile(r"^### (#\d+)\s*[—-]\s*(.+)$")
# kbC lines close their ** after the TITLE, not after the paren group. The original
# pattern required `)**` and therefore matched ZERO of 74 real entries while --check
# reported OK — staleness and coverage are different questions (see CANDIDATE below).
INLINE = re.compile(r"^- \*\*#(\d+[a-z]?) \(([^)]*)\)\s*(.*?)\*\*\s*[—:-]?\s*(.*)$")
# Two kbC entries (#173a/#173b) carry no (date, seat) parenthetical at all.
INLINE_NOPAREN = re.compile(r"^- \*\*#(\d+[a-z]?)\s*[—-]\s*(.*)$")
# INDEPENDENT instrument, deliberately dumber than the parsers above: it answers
# "how many kbC lines EXIST", which is the question a generated-vs-file diff cannot
# ask. rows == enumerated says nothing about enumerated == exists.
CANDIDATE = re.compile(r"^- \*\*#\d")


def clip(s: str) -> str:
    s = re.sub(r"\s+", " ", s.strip())
    s = s.replace("**", "").replace("`", "")
    return s if len(s) <= TITLE_MAX else s[: TITLE_MAX - 1] + "…"


def build() -> str:
    lines = SRC.read_text(encoding="utf-8").split("\n")
    entries = []  # (line_no, kind, key, title)
    for i, raw in enumerate(lines, start=1):
        m = RULE.match(raw)
        if m:
            entries.append((i, "kbA", m.group(1), clip(m.group(2))))
            continue
        m = INLINE.match(raw)
        if m:
            entries.append((i, "kbC", "#" + m.group(1), clip(m.group(3) or m.group(4) or m.group(2))))
            continue
        m = INLINE_NOPAREN.match(raw)
        if m:
            entries.append((i, "kbC", "#" + m.group(1), clip(m.group(2))))
            continue
        m = SECTION.match(raw)
        if m:
            entries.append((i, "sec", "", clip(m.group(1))))

    # COVERAGE ASSERTION — hard fail, not a warning. Counted from the raw source with
    # CANDIDATE, so a parser that silently stops matching cannot hide behind a digest
    # that still regenerates byte-identically.
    existing = sum(1 for raw in lines if CANDIDATE.match(raw))
    indexed = sum(1 for e in entries if e[1] == "kbC")
    if indexed != existing:
        raise SystemExit(
            f"COVERAGE FAIL: {existing} kbC candidate lines in {SRC.name}, "
            f"{indexed} indexed. The kbC parser does not cover the source."
        )

    # End line of each entry = start of the next one minus 1; last runs to EOF.
    # An address without an END is an invitation to read to the bottom of a 551 KB
    # file, which is the cost this digest exists to avoid.
    spans = []
    for idx, (ln, kind, key, title) in enumerate(entries):
        end = entries[idx + 1][0] - 1 if idx + 1 < len(entries) else len(lines)
        spans.append((ln, end, kind, key, title))

    out = []
    out.append("# knowledge.md — BOOT DIGEST (generated; do not hand-edit)")
    out.append("")
    out.append(f"> Source: `knowledge.md`, {SRC.stat().st_size:,} bytes, {len(lines):,} lines.")
    out.append("> Regenerate: `python3 tools/make-knowledge-digest.py`. Verify: add `--check` (exit 3 = stale).")
    out.append(">")
    out.append("> ⛔ **THIS IS AN INDEX, NOT THE KNOWLEDGE.** Read ONE entry by its address:")
    out.append("> `sed -n 'START,ENDp' knowledge.md`. Do NOT read knowledge.md whole at boot —")
    out.append("> that is the 551 KB read this file exists to replace.")
    out.append(">")
    out.append("> ⚠ **CITATION NAMESPACES ARE REAL AND A BARE `#N` IS AMBIGUOUS.**")
    out.append("> `kbA#N` = a `### #N` rule · `kbC#N` = a `- **#N (date, seat)**` entry.")
    out.append("> The two series OVERLAP on ~70 numbers. Always write the namespace.")
    out.append("")
    for label, kind in (("kbA — numbered rules", "kbA"), ("kbC — dated entries", "kbC"), ("Sections", "sec")):
        rows = [s for s in spans if s[2] == kind]
        out.append(f"## {label} ({len(rows)})")
        out.append("")
        for start, end, _k, key, title in rows:
            tag = f"{kind}{key} " if key else ""
            out.append(f"- `{start}-{end}` {tag}{title}")
        out.append("")
    return "\n".join(out) + "\n"


def main() -> int:
    text = build()
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != text:
            print(f"STALE: {OUT.name} differs from a fresh generation of {SRC.name}")
            return 3
        print(f"OK: {OUT.name} matches {SRC.name}")
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT} — {len(text.encode('utf-8')):,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
