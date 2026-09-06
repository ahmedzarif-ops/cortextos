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
extract_failures() {
  grep -E '^[[:space:]]*FAIL' "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | sort -u
}

run_suite() {
  # $1 = directory, $2 = output file. Returns 0 whether or not tests fail; the CALLER reads the
  # failure set. A non-zero suite exit is the expected case here, not an error condition.
  ( cd "$1" && npm test ) > "$2" 2>&1
  # Guard against an output file that contains no recognisable vitest summary at all — that means the
  # run did not happen (missing deps, crash), and an EMPTY failure set from it would read as "green".
  if ! grep -qE '^[[:space:]]*(Test Files|Tests)[[:space:]]' "$2"; then
    return 1
  fi
  return 0
}

# --- 1. the branch under test -------------------------------------------------------------------
say "building working tree..."
npm run build --silent || die "Build failed. Fix the build before pushing — a not-worse gate cannot compare a tree that does not compile."

say "running suite on the working tree..."
HEAD_OUT="$(mktemp)"
run_suite "$REPO_ROOT" "$HEAD_OUT" || die "The suite produced no summary on the working tree. Refusing to guess. Output: $HEAD_OUT"
extract_failures "$HEAD_OUT" > "${HEAD_OUT}.fails"
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
  if ! run_suite "$BASE_DIR" "$BASE_OUT"; then
    git worktree remove --force "$BASE_DIR" 2>/dev/null
    die "The suite produced no summary on the baseline. FAILING CLOSED rather than treating an empty set as green."
  fi
  extract_failures "$BASE_OUT" > "$CACHED_FAILS"
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
