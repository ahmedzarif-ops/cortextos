#!/usr/bin/env bash
# setup-hooks.sh — point this clone at the repo's tracked git hooks
#
# Run once after cloning:
#   bash scripts/setup-hooks.sh
#
# Installs a pre-push hook that runs npm run build && npm test — the FAST lane — before any
# push. If either fails, the push is aborted and you fix it locally rather than on CI.
# (The "FAST lane" wording comes from PR #3, which moved the timing simulations to a slow lane;
# the rest of this header comes from PR #2. Merged by hand 2026-09-04: the ONLY conflict between
# them was this comment block — zero non-comment lines — and both statements are true, so the
# substantive core.hooksPath explanation is kept whole and #3's qualifier folded into line 1.)
#
# WHY THIS SETS core.hooksPath INSTEAD OF COPYING (changed 2026-09-04, guard F1)
#
# It used to `cp scripts/hooks/pre-push .git/hooks/pre-push`, non-clobbering. Both halves of
# that were wrong for the failure we actually had:
#
#   1. A COPY GOES STALE THE MOMENT THE SOURCE IS FIXED. The GIT_DIR-leak repair landed in
#      scripts/hooks/pre-push. Every clone that had already run this script kept executing its
#      Aug-19 copy, which has no `unset` lines at all. So MERGING THE FIX DISARMED NOTHING —
#      the repaired hook sat in the tree while the leaking one kept running.
#   2. NON-CLOBBERING MADE THAT PERMANENT. Seeing a hook already there, the script printed
#      "Skipped ... (leaving your hook in place)" and exited 0. A reassuring success line over
#      a clone that is still leaking.
#
# core.hooksPath makes the TRACKED directory the hooks that run. There is no second copy, so
# there is nothing to fall behind: a fix to scripts/hooks/ is live on the next push, and
# `git log` on that file is an honest history of what actually executes.
#
# Note that git ignores .git/hooks entirely once core.hooksPath is set, so any old copy there
# becomes inert rather than conflicting. This script says so explicitly instead of leaving a
# stale file to look active.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: must be run from inside a git repository." >&2
  exit 1
}

cd "$REPO_ROOT"

HOOKS_SRC_REL="scripts/hooks"

if [[ ! -d "$REPO_ROOT/$HOOKS_SRC_REL" ]]; then
  echo "Error: hook directory not found: $REPO_ROOT/$HOOKS_SRC_REL" >&2
  exit 1
fi

if [[ ! -x "$REPO_ROOT/$HOOKS_SRC_REL/pre-push" ]]; then
  echo "Warning: $HOOKS_SRC_REL/pre-push is not executable; fixing." >&2
  chmod +x "$REPO_ROOT/$HOOKS_SRC_REL/pre-push"
fi

echo "Pointing this clone at the repo's tracked hooks..."
git config core.hooksPath "$HOOKS_SRC_REL"

# READ IT BACK. Setting a config value and reporting success without reading it is the same
# shape as the copy that went stale: a claim about state rather than a look at it.
CONFIGURED="$(git config --get core.hooksPath || true)"
if [[ "$CONFIGURED" != "$HOOKS_SRC_REL" ]]; then
  echo "Error: core.hooksPath did not take (got '${CONFIGURED:-<unset>}')." >&2
  exit 1
fi
echo "  core.hooksPath = $CONFIGURED"

# Name the now-inert copy rather than leaving it to look active.
STALE="$REPO_ROOT/.git/hooks/pre-push"
if [[ -e "$STALE" || -L "$STALE" ]]; then
  if cmp -s "$REPO_ROOT/$HOOKS_SRC_REL/pre-push" "$STALE"; then
    echo "  Note: .git/hooks/pre-push exists and matches the tracked hook. It is now unused"
    echo "        (core.hooksPath takes precedence); safe to delete."
  else
    echo "  ⚠ .git/hooks/pre-push exists and DIFFERS from the tracked hook."
    echo "    It is now INERT — core.hooksPath takes precedence — but if you installed it"
    echo "    deliberately, move it into $HOOKS_SRC_REL/ or it will no longer run."
  fi
fi

echo "Done. Hooks active for this clone, and they track the repo."
