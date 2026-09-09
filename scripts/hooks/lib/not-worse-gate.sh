#!/usr/bin/env bash
# not-worse-gate.sh — pass a push when it introduces no NEW test failures.
#
# THE PROBLEM
# -----------
# The pre-push hook demanded a green suite. `main` has not been green for some time, so the hook was
# unpassable by construction: every push, including pushes that fixed things, required a `--no-verify`.
# A gate that must be bypassed to do ordinary work stops being a gate — people learn the bypass, and
# then it is not there on the day it would have caught something.
#
# THE RULE THIS IMPLEMENTS
# ------------------------
# Compare the failure SET, not the count, against `origin/main` computed AT GATE TIME.
#
#   - SET, not count: a change that fixes one test and breaks another leaves the count identical.
#     The count is the statistic most likely to be quoted and least likely to be right.
#   - AT GATE TIME, not a stored number: a baseline recorded yesterday describes yesterday's main.
#   - Over the WHOLE SUITE, not the tests you thought you touched: the scope of a regression is not
#     knowable in advance, and a gate over a self-chosen subset is a zero over the wrong set.
#
# LIKE-FOR-LIKE IS LOAD-BEARING, NOT PEDANTRY
# -------------------------------------------
# The baseline is checked out at an explicit sha in its own worktree, with its OWN dependency install
# and its OWN build, then run identically. This is not ceremony. A real incident: a comparison between
# a built tree and an unbuilt one reported six phantom regressions, because
# `tests/integration/upgrade-cron-teaching-cli.test.ts` opens with
# `describe.skipIf(!existsSync(DIST_CLI))` — six tests RAN on one side and were SKIPPED on the other.
# BUILD STATE IS CONFIGURATION. A baseline taken in a different configuration is not a baseline, and it
# fails in whichever direction luck chooses: that time it accused an innocent change, and with the trees
# swapped it would have hidden six real regressions behind a clean diff.
#
# FAIL CLOSED
# -----------
# If the baseline cannot be computed, this gate BLOCKS and says why. It does not fall through to
# "allow". A gate that silently degrades to permissive when its instrument breaks is worse than no gate:
# it reports a pass for a question it never asked. `git push --no-verify` remains the deliberate,
# visible escape.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

BASELINE_ROOT="${TMPDIR:-/tmp}/cortextos-not-worse-baselines"
REMOTE="${NOT_WORSE_REMOTE:-origin}"
BASE_REF="${NOT_WORSE_BASE_REF:-main}"

say() { printf '[not-worse] %s\n' "$*"; }
die() { printf '[not-worse] %s\n' "$*" >&2; exit 1; }

# Extract a stable identity per failing test from vitest output.
#
# Two shapes appear and BOTH matter:
#   "FAIL  path/to/file.test.ts > suite > test name"   — an individual test failed
#   "FAIL  path/to/file.test.ts [ path/to/file.test.ts ]" — the file failed to load at all
# The second has no test names, so a comparison keyed only on test names would silently ignore a whole
# file failing to import. Keying on the raw line covers both.
# ⛔ TWO KINDS OF ROW, BECAUSE THE RUNNER CAN FAIL WITHOUT ANY TEST FAILING.
#
# Matching only `FAIL` meant an unhandled rejection extracted ZERO rows while npm exited 1, and
# the caller read that empty set as "clean". `UNHANDLED` rows close that: the run now produces a
# row that must be compared like any other.
#
# ⚠ WHAT AN `UNHANDLED` ROW'S IDENTITY IS, STATED RATHER THAN IMPLIED: the error headline. Two
# different rejections carrying the same message compare EQUAL — exactly as two different failures
# of the same test name already do. That is a property of comparing rendered text, not something
# this change introduces, but it is now true of a second row kind so it is written down.
extract_failures() {
  {
    grep -E '^[[:space:]]*FAIL' "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
    awk '
      /Unhandled (Errors|Error|Rejection)/ { inblk = 1; next }
      # ⚠ THE PREFIX IS OPTIONAL. The first version required at least one character before
      # `Error`, so it matched `TypeError:` and MISSED the plain `Error:` that Vitest actually
      # prints — the exact line this whole change exists to catch. The cardinality control in
      # assert_nameable() caught it within minutes: the summary declared 1 error and the
      # extractor produced 0 rows, so the gate failed CLOSED instead of passing. That is the
      # control working on its author, which is the only test of a control that counts.
      inblk && /^[A-Za-z0-9_$]*(Error|Exception):/ { print "UNHANDLED " $0; inblk = 0 }
    ' "$1" | sed -E 's/[[:space:]]+$//'
  } | sort -u
}

# ⛔ OCCURRENCES, COUNTED BEFORE DEDUPLICATION — the two numbers being reconciled must count the
# same kind of thing. `extract_failures` ends in `sort -u`, so two identical error messages collapse
# to ONE row while the reporter counts TWO errors. Reconciling a reporter's OCCURRENCE count against
# deduplicated IDENTITIES would refuse a perfectly ordinary duplicate — and, worse, would tempt the
# next person to relax the check. Count occurrences here; deduplicate only for the comparison set.
unhandled_occurrences() {
  awk '
    /Unhandled (Errors|Error|Rejection)/ { inblk = 1; next }
    inblk && /^[A-Za-z0-9_$]*(Error|Exception):/ { n++; inblk = 0 }
    END { print n + 0 }
  ' "$1"
}

# How many errors the runner SAYS it had, read off its own summary line.
declared_errors() {
  sed -nE 's/^[[:space:]]*Errors[[:space:]]+([0-9]+)[[:space:]]+error.*/\1/p' "$1" | head -1
}

# ⛔ THE EXIT STATUS IS EVIDENCE AND IS NEVER DISCARDED.
#
# THE COMMENT THAT USED TO SIT HERE IS THE DEFECT, WRITTEN DOWN AS A DESIGN NOTE:
#   "Returns 0 whether or not tests fail; the CALLER reads the failure set.
#    A non-zero suite exit is the expected case here, not an error condition."
# The first sentence is true of ASSERTION failures and false of everything else the runner can do.
# Vitest exits 1 with every assertion passing when it catches an unhandled rejection — the report
# says `Errors  1 error` and prints an Unhandled Errors block with NO `FAIL` line — so the caller
# read an empty failure set and the gate answered "no failures — PASS" without fetching a baseline
# at all. Measured by guard 2026-09-09 against real Vitest in an isolated fixture: npm exit 1,
# gate exit 0. That is MORE permissive than the not-worse policy this gate advertises.
#
# Two status variables, because they answer different questions:
#   SUITE_RC       — what the runner said about ITSELF
#   SUITE_SUMMARY  — whether a result can be READ at all
# A caller that reads one without the other is back where this started.
#
# ⚠ THIS IS NOT A STRUCTURED REPORTER CONTRACT, AND CALLING IT ONE WOULD BE THE SAME MISTAKE ONE
# LEVEL UP (guard's note, and it is fair). This is still a PARSER over rendered human-readable
# output, and its declared and extracted outcomes can disagree — which is exactly why the
# reconciliation below refuses rather than reports. A real contract would mean consuming the
# runner's machine-readable reporter; that is a larger change than this fix and is not claimed.
SUITE_RC=0
SUITE_SUMMARY=0
run_suite() {
  # $1 = directory, $2 = output file.
  ( cd "$1" && npm test ) > "$2" 2>&1
  SUITE_RC=$?
  # No recognisable summary means the run did not happen (missing deps, crash) — and an EMPTY
  # failure set from it would read as "green".
  if grep -qE '^[[:space:]]*(Test Files|Tests)[[:space:]]' "$2"; then
    SUITE_SUMMARY=1
  else
    SUITE_SUMMARY=0
  fi
}

# ⛔ FAIL CLOSED ON ANYTHING THIS GATE CANNOT NAME.
#
# The contract is "compare the failures HERE against the failures THERE", and it is meaningful
# only over failures this gate can IDENTIFY. A non-zero runner exit with nothing extractable is
# not a clean run — it is a run whose failures this parser cannot name, and the only honest answer
# is to refuse.
#
# Four refusals, separate because they mean different things:
#   no summary                          -> the run did not complete, or its output is unreadable
#   rc != 0 and zero rows               -> it failed and this parser cannot say why
#   declared errors but no UNHANDLED row-> the reporter changed shape; the extractor is behind it
#   rc == 0 but rows extracted          -> status and output disagree
# The third is a CARDINALITY CONTROL between the extractor and the reporter's own count. Without
# it, the fix for this defect would be "one more regex", and the next reporter change would put
# the gate straight back into silent-pass — which is the failure mode, not the bug.
assert_nameable() {
  out="$1"; fails="$2"; rc="$3"; where="$4"
  [ "$SUITE_SUMMARY" -eq 1 ] || die "The suite produced no summary on the $where. FAILING CLOSED: an unreadable result is not an empty one. Output: $out"
  count=$(wc -l < "$fails" | tr -d ' ')
  declared=$(declared_errors "$out")
  [ -n "$declared" ] || declared=0
  named=$(unhandled_occurrences "$out")
  # ⛔ EQUALITY, NOT EXISTENCE. This was `declared > 0 && named == 0` — an EXISTENCE check wearing a
  # cardinality check's name, and guard broke it in one move: a baseline with one nameable error and
  # a branch adding one UNNAMEABLE one gives declared 2 / named 1 / npm 1, the extractor emits the
  # inherited row only, the comparison finds nothing new, and the gate PASSES. A brand-new runner
  # failure admitted as "not worse". PARTIAL CAPTURE IS THE DANGEROUS CASE, NOT ZERO CAPTURE: zero
  # is loud, partial looks exactly like a clean read of a smaller problem.
  if [ "$declared" -ne "$named" ]; then
    die "The $where reported $declared runner error(s) and this gate could name $named of them. FAILING CLOSED: the difference is failures I cannot name. Do NOT widen a pattern until the counts agree — read $out and decide deliberately."
  fi
  if [ "$rc" -ne 0 ] && [ "$count" -eq 0 ]; then
    die "The suite exited $rc on the $where with a readable summary and no failure this gate can identify. FAILING CLOSED: these are failures I cannot name. Do NOT widen a pattern until this passes — read $out and decide deliberately."
  fi
  if [ "$rc" -eq 0 ] && [ "$count" -gt 0 ]; then
    die "The suite exited 0 on the $where while this gate extracted $count failure row(s). Status and output disagree; FAILING CLOSED rather than believing whichever one is convenient. Output: $out"
  fi
}

# --- 1. the branch under test -------------------------------------------------------------------
say "building working tree..."
npm run build --silent || die "Build failed. Fix the build before pushing — a not-worse gate cannot compare a tree that does not compile."

say "running suite on the working tree..."
HEAD_OUT="$(mktemp)"
run_suite "$REPO_ROOT" "$HEAD_OUT"
HEAD_RC=$SUITE_RC
extract_failures "$HEAD_OUT" > "${HEAD_OUT}.fails"
assert_nameable "$HEAD_OUT" "${HEAD_OUT}.fails" "$HEAD_RC" "working tree"
HEAD_COUNT=$(wc -l < "${HEAD_OUT}.fails" | tr -d ' ')

if [ "$HEAD_COUNT" -eq 0 ]; then
  say "no failures on the working tree — nothing to compare. PASS."
  exit 0
fi
say "working tree has $HEAD_COUNT failing entr(ies); computing the $REMOTE/$BASE_REF baseline to see whether they are new..."

# --- 2. the baseline, pinned by REF at gate time ------------------------------------------------
git fetch --quiet "$REMOTE" "$BASE_REF" 2>/dev/null \
  || die "Could not fetch $REMOTE/$BASE_REF. FAILING CLOSED: without a baseline this gate cannot tell a new failure from an inherited one. Use --no-verify deliberately if you must push offline."

BASE_SHA="$(git rev-parse "$REMOTE/$BASE_REF" 2>/dev/null)"
[ -n "$BASE_SHA" ] || die "Could not resolve $REMOTE/$BASE_REF to a sha. FAILING CLOSED."
say "baseline ref $REMOTE/$BASE_REF = $BASE_SHA"

BASE_DIR="$BASELINE_ROOT/$BASE_SHA"
CACHED_FAILS="$BASE_DIR/.not-worse-failures"

if [ -f "$CACHED_FAILS" ]; then
  say "reusing cached baseline for $BASE_SHA (keyed by sha, so it cannot go stale against a moving main)"
else
  say "preparing a clean baseline worktree at $BASE_SHA (own install, own build — build state is configuration)"
  rm -rf "$BASE_DIR"
  mkdir -p "$BASELINE_ROOT"
  git worktree add --detach --quiet "$BASE_DIR" "$BASE_SHA" \
    || die "Could not create the baseline worktree at $BASE_SHA. FAILING CLOSED."
  ( cd "$BASE_DIR" && npm install --no-audit --no-fund --silent ) \
    || { git worktree remove --force "$BASE_DIR" 2>/dev/null; die "Baseline dependency install failed. FAILING CLOSED — an unbuilt baseline skips tests the branch runs (see the skipIf note at the top of this file)."; }
  ( cd "$BASE_DIR" && npm run build --silent ) \
    || { git worktree remove --force "$BASE_DIR" 2>/dev/null; die "Baseline build failed. FAILING CLOSED for the same reason."; }

  BASE_OUT="$BASE_DIR/.not-worse-output"
  say "running suite on the baseline..."
  run_suite "$BASE_DIR" "$BASE_OUT"
  BASE_RC=$SUITE_RC
  BASE_SUMMARY=$SUITE_SUMMARY
  extract_failures "$BASE_OUT" > "$BASE_OUT.fails"
  # ⛔ SAME REFUSALS ON THE BASELINE, AND THIS SIDE IS THE MORE DANGEROUS OF THE TWO. An
  # unnameable baseline writes an empty (or short) cache keyed by sha, and every later branch
  # compares against it: real inherited failures then read as NEW, or — if the branch is clean —
  # the emptiness is never noticed at all. The cache is only written AFTER the refusals pass.
  SUITE_SUMMARY=$BASE_SUMMARY
  ( assert_nameable "$BASE_OUT" "$BASE_OUT.fails" "$BASE_RC" "baseline" ) || {
    git worktree remove --force "$BASE_DIR" 2>/dev/null
    exit 1
  }
  mv "$BASE_OUT.fails" "$CACHED_FAILS"
fi

BASE_COUNT=$(wc -l < "$CACHED_FAILS" | tr -d ' ')
say "baseline has $BASE_COUNT failing entr(ies)"

# --- 3. compare SETS ------------------------------------------------------------------------------
NEW_FAILURES="$(comm -13 "$CACHED_FAILS" "${HEAD_OUT}.fails")"
FIXED="$(comm -23 "$CACHED_FAILS" "${HEAD_OUT}.fails")"

if [ -n "$FIXED" ]; then
  say "these were failing on $BASE_REF and pass here:"
  printf '%s\n' "$FIXED" | sed 's/^/    + /'
fi

if [ -n "$NEW_FAILURES" ]; then
  printf '\n[not-worse] ⛔ NEW FAILURES NOT PRESENT ON %s/%s (%s):\n' "$REMOTE" "$BASE_REF" "$BASE_SHA" >&2
  printf '%s\n' "$NEW_FAILURES" | sed 's/^/    - /' >&2
  printf '\n[not-worse] The suite is red on %s too, so the bar is NOT a green run — it is "no new failures".\n' "$BASE_REF" >&2
  printf '[not-worse] The entries above fail here and do not fail there. Push aborted.\n' >&2
  exit 1
fi

say "✅ NOT WORSE: every failing entry here also fails on $BASE_REF@$BASE_SHA."
say "   ⚠ This is NOT a statement that the suite is green — it is $HEAD_COUNT failing entr(ies) on both sides."
exit 0
