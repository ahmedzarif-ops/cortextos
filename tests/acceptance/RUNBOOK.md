# Guard adversarial acceptance suite — routing + lifecycle-notification controls

Offline only. Reads live source; writes nothing outside this worktree. Never
touches the daemon, config, crons, credentials, or the shared checkout.

## What each file is for

- `restart-notification-controls.hostile.test.ts` — ONE VOICE lifecycle
  boundary. Specialists must never be told to push owner Telegram and must
  never have the daemon push on their behalf; the configured orchestrator must
  keep exactly one sender.
- `crash-alert-preservation.hostile.test.ts` — the suppression must not eat the
  alarm. Real crashes and daemon-crashes still fan out to the internal
  chief/analyst path.
- `capacity-signal-trust.hostile.test.ts` — capacity signals must not treat
  self-reported provider/source labels as proof of authentication. Fails closed
  and refuses to run unless told which source is under review.
- `capacity-controller.hostile.test.ts` — adversarial pass over the capacity
  controller. **Also refuses to run without its own env var**
  (`CAPACITY_CONTROLLER_CANDIDATE`), which was undocumented until 2026-09-04.
- `templates-one-voice-guard.test.ts` — the ONE VOICE templates guard: the
  Step-7b whole-file SOUL.md write must name all three sections that carry the
  rule in its preserve list.

⚠ **THIS LIST WAS THREE FILES LONG WHILE THE SUITE HAD FIVE, AND THE TWO OMITTED
ONES WERE NOT RANDOM.** The file left out of the inventory was the same file whose
mandatory env var was left out of the docs — so a reader working only from this
RUNBOOK could not discover it existed, let alone that it gated the run. *An
inventory that is shorter than the directory is not a summary, it is a map with a
room missing.*

## Running it

⛔ **THIS IS AN OPT-IN LANE. IT IS NOT PART OF `npm test` AND IT IS NOT IN CI.**

```bash
# from any worktree at this branch; a worktree with no install needs the symlink
ln -sfn /Users/guest1/cortextos/node_modules node_modules
export CAPACITY_SIGNAL_CANDIDATE=<path to the capacity-signal source under review>
export CAPACITY_CONTROLLER_CANDIDATE=<path to the capacity-controller source under review>
npm run test:acceptance
```

**Why opt-in and not part of the default suite.** Both variables name sources in
*sibling worktrees on one machine*, so **a clean clone cannot run this lane at
all**, however well documented. Under the default glob that is not a strict
suite — it is a suite that fails for everyone who is not its author. Worse,
`restart-notification-controls.hostile.test.ts` only passes with src that is in
**PR #16**, so merging PR #13 first left `main` red. Membership lives in
`tests/acceptance-tests.ts`, which both `vitest.config.ts` (exclude) and
`vitest.acceptance.config.ts` (include) import, so the two lanes cannot drift
into a file belonging to neither.

**Both variables are mandatory by design.** `tests/acceptance/require-env.ts`
runs once before collection and fails with a message that says *setup*, naming
the variable, what it must point at, and which file needs it.
⭐ **THE RUNBOOK'S OWN PRINCIPLE WAS RIGHT AND ONE CASE SHORT.** "A missing env
var and a clean run must never look alike" — true, and **a missing env var and a
BROKEN SUITE must not look alike either.** Both candidates used to throw at
module scope, so an unset variable printed `FAIL tests/acceptance/…`: the shape
of broken code, not of an unconfigured lane. Three states, kept apart on purpose:
unset · set-but-missing · configured.
**And `passWithNoTests` stays false**: a lane that matches no files must FAIL. An
empty lane exiting 0 is the "clean run" half of the same rule.

## Running it against a candidate patch

The suite is written against the base commit and re-applied to whatever patch is
under review:

```bash
git -C /Users/guest1/cortextos diff --binary -- src/ > /tmp/successor-src.patch
git apply /tmp/successor-src.patch
cp /Users/guest1/cortextos/src/telegram/lifecycle.ts src/telegram/lifecycle.ts   # untracked dep
# ...run...
git checkout -- src/                 # restore tracked sources
rm -f src/telegram/lifecycle.ts      # remove ONLY the untracked file you copied in
```

⛔ **Do not `rm -rf src/telegram` to undo that `cp`.** `src/telegram/` is a TRACKED directory holding
six other files; `lifecycle.ts` is merely untracked *inside* it. I ran the `-rf` form on 2026-09-03
and deleted all six. Fully recoverable — they are tracked, `git checkout -- src/telegram` restored
them byte-identical — but the set the command chose was not the set intended. Name the file, not the
directory.

## Positive control for the capacity arm

`CAPACITY_SIGNAL_CANDIDATE` must expose `authenticated` in its options. Only the label-trust test may
run unattested; every other capacity test uses `evaluateSigned()`. Run unattested they would pass
because the input was unsigned rather than because of the defect they name — a pass for the wrong
reason, indistinguishable from a real one.

## Why both arms must be run

A suppression suite run only against the fixed source is close to worthless: it
cannot distinguish "the gate works" from "the feature never initialised". Run
the base arm as the positive control and require the flip.

⛔ **EVERY FIGURE BELOW NAMES THE ARM AND THE COMMAND THAT PRODUCED IT.** The
table that shipped here read `37 passed / 0 failed` — a 37-test suite — while the
suite was 93. A reader who ran it and saw 93 had no way to tell a grown suite from
a wrong run, and the same stale number was already flagged as untraceable in
`GOALS.md`. **A count with no arm attached cannot be checked, only believed.**

**Measured 2026-09-03, `npx vitest run tests/acceptance/`, base `9d4383f`:**

| Arm | Result |
|---|---|
| base commit (control) | 19 failed / 74 passed (93), RC 1 |
| base + notification-noise patch | **93 passed / 0 failed (93), RC 0** |

**Measured 2026-09-04, `npx vitest run tests/`, head `8f85fba`, in a PRISTINE
control worktree vs this branch** — the evidence for moving the lane:

| Arm | Test files | Tests |
|---|---|---|
| `8f85fba` unchanged (acceptance under the default glob) | 11 failed / 124 passed (138) | 48 failed / 2117 passed (2175) |
| this branch (acceptance in its own lane) | 8 failed / 123 passed (134) | **29 failed** / 2078 passed (2117) |

**Exactly the 19 flip out**, and the arithmetic closes: `2175 − 62 acceptance + 4
new lane-partition = 2117`. The remaining 29 failures are present in **both** arms
and are pre-existing at `8f85fba`; this change neither causes nor fixes them.

Superseded numbers, kept so the record is legible: an earlier run read 20F/17P and
1F/36P. That extra red was **my own defect, not the implementation's** — the
positive control and the label-trust test evaluated DEEP-EQUAL input under
identical options while demanding different states, so one of the pair had to
fail against any implementation. It was a seesaw, not a finding. Fixed by giving
the control a genuine attestation via the `authenticated` option.

## Trap this suite already fell into once

The first version called `buildStartupPrompt()` directly. Authority is computed
inside `start()`, so the field under test sat at its default `false` and every
suppression test passed **for the wrong reason** — they would have passed with
the gate deleted. Tests now drive `start()` and assert on the prompt actually
handed to `pty.spawn`. If you add a case, add it through `boot()`.

Likewise, do not assert argv by absolute position: the CLI may be invoked as
`cortextos bus …` or `node <cli.js> bus …`. Anchor on the `bus` verb, or a shape
change reads as a lost alarm.
