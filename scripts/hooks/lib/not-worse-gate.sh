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

# ⛔ PREPARE BOTH SIDES IDENTICALLY, AND `dashboard` IS PART OF "IDENTICALLY".
#
# MEASURED 2026-09-10 at main 2f4a84a, in a tree built exactly the way this gate built its baseline
# (root install + build, no dashboard install):
#     live checkout : rc 0, Tests 2835 passed |  3 skipped (2838)
#     that tree     : rc 1, Tests    2 failed | 50 skipped (2687), 14 failing FILE rows
# 151 tests were NEVER COLLECTED and 47 more self-skipped. CLAUDE.md documents the cause in terms:
# without dashboard/'s install, `next/server` is unresolvable and 47 dashboard-adjacent tests
# silently self-skip.
#
# ⛔⛔ AND THE DIRECTION IS WHY THIS WAS INVISIBLE. `NEW_FAILURES = comm -13 base head` reports
# failures present HERE and absent THERE, so anything already failing in the BASELINE reads as
# INHERITED and is admitted. An under-prepared baseline is over-populated with failures, which makes
# "no worse than base" EASIER to satisfy.
# ⭐ A NOT-WORSE GATE FAILS TOWARD PASSING BY CONSTRUCTION (social's formulation): a baseline defect
# here is a fail-open EVERY time and never a false alarm — a gate that can only err toward green has
# a bug undetectable from its own output. It stayed hidden because the HEAD_COUNT=0 early exit means
# the baseline is not built at all while the working tree is green.
prepare_tree() {
  # $1 = directory, $2 = side label for messages
  ( cd "$1" && npm install --no-audit --no-fund --silent ) \
    || die "Dependency install failed on the $2. FAILING CLOSED — an unprepared tree skips tests the other side runs."
  ( cd "$1" && npm install --prefix dashboard --no-audit --no-fund --silent ) \
    || die "dashboard/ dependency install failed on the $2. FAILING CLOSED — without it 47 tests self-skip and 13 files fail to load, and this gate would compare two different populations."
  ( cd "$1" && npm run build --silent ) \
    || die "Build failed on the $2. FAILING CLOSED — build state is configuration (see the header)."
}

# THE PREREQUISITE CONTROL. tests/unit/prerequisites.test.ts already encodes the two prerequisites
# (dashboard deps, dist/) and fails loudly when either is absent — it exists because "the
# honest-looking green was the failure mode". Run it on BOTH sides BEFORE any comparison.
# ⭐ WITHOUT THIS, THE NEXT MISSING PREREQUISITE REPRODUCES TONIGHT'S INCIDENT EXACTLY. Fixing the
# dashboard install alone fixes THIS instance; the control is what makes the CLASS fail closed.
#
# ⛔⛔ AND IT MUST RUN **OUTSIDE** THE COMPARED POPULATION. THIS IS THE WHOLE REASON IT IS A
# ⛔⛔ SEPARATE INVOCATION THAT CALLS `die`, AND NOT "one more failing row we would have noticed".
# (social's catch, and it is the sharpest thing said about this defect.) prerequisites.test.ts is
# DELIBERATELY not `skipIf` — its own header says a silent skip would reproduce the defect under
# test — so in an under-prepared baseline it FAILS, loudly, in-band. And that alarm is precisely
# what `NEW_FAILURES = comm -13 base head` throws away: it emits rows unique to HEAD, and a
# prerequisites failure present ONLY in the baseline is a base-only row.
# ⇒ ***THE SUBTRACTION IS WHAT ERASES THE ALARM.*** The baseline announces its own invalidity and
# the comparison converts that announcement into permission. A prerequisite check that lives inside
# the compared population is CANCELLED BY THE COMPARISON, however loudly it is written — the repo
# already shipped the loud-test version, and this gate was defeating it.
assert_prerequisites() {
  # $1 = directory, $2 = side label ("base" or "head")
  # ⛔ THE OUTPUT MUST NOT LIVE INSIDE THE TREE BEING CHECKED. First version wrote it to
  # "$1/.gate-prereq-output", and the EXIT trap that removes the scratch worktree deleted it on the
  # way out — so the refusal named a path that no longer existed by the time anyone read it. That is
  # a dangling reference produced by the cleanup, i.e. this repo's own "listed above" defect wearing
  # a filename. Caught on the first real run of this control, by following its own pointer.
  pout="$(mktemp)"
  ( cd "$1" && npx vitest run tests/unit/prerequisites.test.ts ) > "$pout" 2>&1
  prc=$?
  grep -qE '^[[:space:]]*Test Files[[:space:]]' "$pout" \
    || die "gate-prerequisite-missing side=$2 — the prerequisite suite produced no summary. FAILING CLOSED: an unreadable result is not a passing one. Output: $pout"
  [ "$prc" -eq 0 ] \
    || die "gate-prerequisite-missing side=$2 — tests/unit/prerequisites.test.ts is not green (rc=$prc). This gate compares two trees, and an unprepared one silently collects FEWER TESTS rather than failing. Output: $pout"
}

# The TOTAL COLLECTED count, from the parenthesised total on vitest's `Tests` summary line
# (`Tests  2835 passed | 3 skipped (2838)`). This is the population size — the number the incident
# moved by 151 while every other reported figure still looked plausible.
collected_tests() {
  sed -nE 's/^[[:space:]]*Tests[[:space:]]+.*\(([0-9]+)\)[[:space:]]*$/\1/p' "$1" | tail -1
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

# ⛔ ONE EXTRACTION, TWO READERS. The predicate below COUNTS these rows and the diagnostic
# PRINTS them, and they must be the same rows — not "the same query written twice".
# ⭐ WHY THIS IS A FUNCTION AND NOT A WIDER CHARACTER CLASS: the two call sites HAD DRIFTED,
# and drift is what a duplicated query does. #46 fixed the PREDICATE to count any test-path
# change (A/M/D/R) after guard measured a MODIFY-only diff hitting the strict arm and refusing
# a valid push — and left the DIAGNOSTIC filtering `^[AD]`. So on a modify-only diff the gate
# printed:
#     ⚠ FINDING: collected totals differ (X vs Y) and the diff touches 1 test path(s):
#     <nothing>
# A finding with a colon and an empty list, which reads as THE PREDICATE being wrong when the
# PRINTER is wrong. Measured on real shas (a commit modifying one .test.ts, adding none):
# predicate 1, diagnostic rows 0.
# ⇒ A widened class would fix today's disagreement and leave tomorrow's possible. One function
# cannot disagree with itself.
changed_test_paths() {                     # $1=base sha, $2=head sha; emits "<status>\t<path>"
  git diff --name-status "$1" "$2" -- '*.test.ts' '*.test.tsx' 2>/dev/null
}

# ---- functions end ----
# ⛔ THAT MARKER IS AN INTERFACE, NOT A COMMENT. tests/unit/hooks/not-worse-gate.test.ts sources only
# the definitions above it, by cutting this file at this exact line. It used to cut at the PROSE
# string `say "building working tree..."`; that line was renamed during this change, `indexOf`
# returned -1, and EIGHT arms failed on a LOCATOR while naming assertions — loud, and pointing at
# the wrong thing. A structural cut needs a structural anchor. Do not move, reword or delete this
# line without changing that test in the same commit.

# --- 1. the branch under test, IN ITS OWN WORKTREE ----------------------------------------------
#
# ⛔ THIS USED TO RUN `npm run build` IN $REPO_ROOT — THE LIVE CHECKOUT — WHICH MADE `git push` A
# ⛔ DEPLOY ON ANY MACHINE WHERE dist/ IS THE INSTALLED CLI.
# MEASURED 2026-09-10 on this repo: ~/.local/bin/cortextos -> ../lib/node_modules/cortextos/dist/cli.js
# and ~/.local/lib/node_modules/cortextos -> the checkout, so a push shipped the PUSHED BRANCH to
# every running agent instantly. dist/cli.js changed hash across a push of an unmerged branch and the
# live CLI began answering with that branch's behaviour. The gate never restored it.
# ⭐ A GATE IS TRUSTED PRECISELY BECAUSE IT IS BELIEVED TO BE READ-ONLY, so its WRITES are the ones
# nobody audits. The baseline half of this file was already isolated in a worktree; the head half was
# not, in the same file, for the same purpose.
#
# ⛔ SNAPSHOT-AND-RESTORE WAS CONSIDERED AND REJECTED, and the reason is recorded so nobody
# re-proposes it: a gate that saves dist/, mutates it and restores it afterwards leaves the MUTATED
# version live whenever it dies or is interrupted — fail-open, silent, and indistinguishable from an
# ordinary refused push. That is the incident itself, with a smaller window.
HEAD_SHA="$(git rev-parse HEAD)"
HEAD_DIR="$BASELINE_ROOT/head-$HEAD_SHA"
say "preparing a head worktree at $HEAD_SHA (own install, own build — nothing writes the live tree)"
rm -rf "$HEAD_DIR"
mkdir -p "$BASELINE_ROOT"
git worktree add --detach --quiet "$HEAD_DIR" "$HEAD_SHA" \
  || die "Could not create the head worktree at $HEAD_SHA. FAILING CLOSED."
# The head worktree is scratch: remove it however this script exits, so a failed gate cannot leave
# a half-prepared tree behind to be reused as if it were sound.
# ⛔ THE TRAP MUST COVER THE BASELINE TOO, AND THE OLD INLINE CLEANUPS COULD NOT.
# `die()` ends with `exit 1` IN THIS SHELL, so `prepare_tree ... || { git worktree remove ...; }`
# is unreachable by construction: the `||` arm never runs because the left side never returns.
# A half-prepared baseline left on disk is worse than none — it is keyed by sha and the next push
# reuses it as if it were sound. BASE_DIR_PENDING is cleared only once its cache file is written.
BASE_DIR_PENDING=""
cleanup_worktrees() {
  git worktree remove --force "$HEAD_DIR" 2>/dev/null
  [ -n "$BASE_DIR_PENDING" ] && git worktree remove --force "$BASE_DIR_PENDING" 2>/dev/null
  return 0
}
trap cleanup_worktrees EXIT
prepare_tree "$HEAD_DIR" "head"

# ⚠ THE GATE NOW TESTS **HEAD**, NOT THE WORKING TREE. Said out loud because it is a real change in
# what is being gated: uncommitted changes are no longer included. For a PRE-PUSH gate that is the
# more honest subject — a push carries commits, not the working tree — but a reader who expects the
# old behaviour would otherwise discover it by surprise.
assert_prerequisites "$HEAD_DIR" "head"

say "running suite on the head worktree..."
HEAD_OUT="$(mktemp)"
run_suite "$HEAD_DIR" "$HEAD_OUT"
HEAD_RC=$SUITE_RC
extract_failures "$HEAD_OUT" > "${HEAD_OUT}.fails"
assert_nameable "$HEAD_OUT" "${HEAD_OUT}.fails" "$HEAD_RC" "head worktree"
HEAD_COUNT=$(wc -l < "${HEAD_OUT}.fails" | tr -d ' ')
HEAD_COLLECTED=$(collected_tests "$HEAD_OUT")

if [ "$HEAD_COUNT" -eq 0 ]; then
  # Safe to stop here ONLY because the prerequisite control above already ran on this side: a green
  # run over a silently smaller population is exactly what that control refuses.
  say "no failures on the head worktree (collected_head=${HEAD_COLLECTED:-unknown}) — nothing to compare. PASS."
  exit 0
fi
say "head has $HEAD_COUNT failing entr(ies); computing the $REMOTE/$BASE_REF baseline to see whether they are new..."

# --- 2. the baseline, pinned by REF at gate time ------------------------------------------------
git fetch --quiet "$REMOTE" "$BASE_REF" 2>/dev/null \
  || die "Could not fetch $REMOTE/$BASE_REF. FAILING CLOSED: without a baseline this gate cannot tell a new failure from an inherited one. Use --no-verify deliberately if you must push offline."

BASE_SHA="$(git rev-parse "$REMOTE/$BASE_REF" 2>/dev/null)"
[ -n "$BASE_SHA" ] || die "Could not resolve $REMOTE/$BASE_REF to a sha. FAILING CLOSED."
say "baseline ref $REMOTE/$BASE_REF = $BASE_SHA"

BASE_DIR="$BASELINE_ROOT/$BASE_SHA"
CACHED_FAILS="$BASE_DIR/.not-worse-failures"
# The POPULATION SIZE is cached beside the failure set, because a cache hit skips the suite run and
# the count would otherwise be unavailable on exactly the fast path most pushes take.
CACHED_COLLECTED="$BASE_DIR/.not-worse-collected"

if [ -f "$CACHED_FAILS" ]; then
  say "reusing cached baseline for $BASE_SHA (keyed by sha, so it cannot go stale against a moving main)"
else
  say "preparing a clean baseline worktree at $BASE_SHA (own install, own build — build state is configuration)"
  rm -rf "$BASE_DIR"
  mkdir -p "$BASELINE_ROOT"
  git worktree add --detach --quiet "$BASE_DIR" "$BASE_SHA" \
    || die "Could not create the baseline worktree at $BASE_SHA. FAILING CLOSED."
  BASE_DIR_PENDING="$BASE_DIR"
  prepare_tree "$BASE_DIR" "baseline"
  assert_prerequisites "$BASE_DIR" "base"

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
  collected_tests "$BASE_OUT" > "$CACHED_COLLECTED"
  mv "$BASE_OUT.fails" "$CACHED_FAILS"
  # The baseline is sound and cached from here on; the trap must stop treating it as scratch.
  BASE_DIR_PENDING=""
fi

BASE_COUNT=$(wc -l < "$CACHED_FAILS" | tr -d ' ')
BASE_COLLECTED=$(cat "$CACHED_COLLECTED" 2>/dev/null)
say "baseline has $BASE_COUNT failing entr(ies)"

# --- 2b. THE POPULATIONS MUST BE THE SAME POPULATION ----------------------------------------------
#
# A set comparison is only as honest as the equality of the two populations behind it. Both sides can
# be individually correct and the comparison still false, and nothing in the comparison's own output
# says which. So state the sizes, and refuse when they differ for a reason the diff cannot explain.
#
# ⚠ THE BOUND IS DELIBERATELY NOT A THRESHOLD. "Allow a difference proportional to the test files the
# diff touches" compares TESTS to FILES: one added file carrying twenty cases would refuse an
# ordinary PR, and a gate that refuses ordinary work teaches people the bypass — which this file's
# own header exists to prevent. A false-positive rate is a correctness property of a check.
# So: when the diff adds or removes NO test files the expectation is EXACT and is enforced; when it
# does, a file count cannot bound a test count in either direction, so the counts are REPORTED and
# the refusal is left to the prerequisite control above. No invented number.
# ⛔ ANY CHANGE TO A TEST PATH COUNTS AS TOUCHING IT — A/M/D/R, not just A and D.
# (guard's P2, reproduced: base=2 head=3, test_files_added_or_removed=0, rc 1 on a VALID push.)
# The first version counted only ADDED and DELETED files, so a diff that MODIFIES a test file to add
# one green test read as "no test files changed" and hit the STRICT arm — which then refused the
# push for a collected-count difference the diff fully explains.
# ⭐ That is the false positive this block's own comment warns about, committed in the block that
# warns about it: a gate that refuses ordinary work teaches the bypass. The strict arm is only
# honest when the diff touches NO test path at all.
TEST_FILE_DELTA="$(changed_test_paths "$BASE_SHA" "$HEAD_SHA" | grep -c .)"
say "collected_base=${BASE_COLLECTED:-unknown} collected_head=${HEAD_COLLECTED:-unknown} test_paths_changed=${TEST_FILE_DELTA:-0}"
if [ -z "$BASE_COLLECTED" ] || [ -z "$HEAD_COLLECTED" ]; then
  die "populations-unknown — could not read a collected-test total from one of the runs. FAILING CLOSED: a comparison whose population sizes are unknown is not a comparison."
fi
if [ "${TEST_FILE_DELTA:-0}" -eq 0 ] && [ "$BASE_COLLECTED" != "$HEAD_COLLECTED" ]; then
  die "populations-differ base=$BASE_COLLECTED head=$HEAD_COLLECTED while the diff touches NO test path at all (added, modified, deleted or renamed). FAILING CLOSED: the two sides ran different numbers of tests, so 'no new failures' is a statement about two different suites. This is the exact shape of the 151-test dashboard gap this control was added for."
fi
if [ "${TEST_FILE_DELTA:-0}" -gt 0 ] && [ "$BASE_COLLECTED" != "$HEAD_COLLECTED" ]; then
  say "⚠ FINDING: collected totals differ ($BASE_COLLECTED vs $HEAD_COLLECTED) and the diff touches $TEST_FILE_DELTA test path(s):"
  changed_test_paths "$BASE_SHA" "$HEAD_SHA" | sed 's/^/    /'
  say "   Not a refusal: a file count cannot bound a test count. The prerequisite control on both sides is what refuses an under-prepared tree."
fi

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
