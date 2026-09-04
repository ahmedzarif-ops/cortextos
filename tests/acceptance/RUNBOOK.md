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

## Running it

```bash
cd /Users/guest1/cortextos-worktrees/guard-routing-restart-acceptance-20260903
ln -sfn /Users/guest1/cortextos/node_modules node_modules   # this worktree has no install
export CAPACITY_SIGNAL_CANDIDATE=/Users/guest1/cortextos-worktrees/non-secret-capacity-signal/src/bus/capacity-signal.ts
node_modules/.bin/vitest run tests/acceptance/
```

`CAPACITY_SIGNAL_CANDIDATE` is mandatory by design: without it the capacity file
throws at collection instead of reporting a hollow pass. A missing env var and a
clean run must never look alike.

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

Measured 2026-09-03, base `9d4383f`:

| Arm | Result |
|---|---|
| base commit (control) | 19 failed / 18 passed, RC 1 |
| base + notification-noise patch | **37 passed / 0 failed, RC 0** |

19 tests flip fail→pass; the patched arm is fully green.

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
