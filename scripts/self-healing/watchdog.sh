#!/bin/bash
# Daemon-level watchdog for cortextOS.
# Detects when the Telegram poller is wedged (accumulated fetch failures) and
# restarts cortextos-daemon via PM2 to clear stuck connections.
#
# Runs every 5 minutes via launchd. See README.md for install instructions.

set -u

INSTANCE="${CTX_INSTANCE_ID:-default}"
ERR_LOG="${PM2_HOME:-$HOME/.pm2}/logs/cortextos-daemon-error.log"
STATE_FILE="$HOME/.cortextos/$INSTANCE/watchdog-state"
LOG_FILE="$HOME/.cortextos/$INSTANCE/logs/watchdog.log"

# Threshold: if more than this many new poller-error lines appeared since the
# last check (≈5 min ago), assume wedge and restart. A healthy daemon produces
# 0–2 transient poll errors over 5 min; a wedged daemon spams hundreds.
THRESHOLD="${WATCHDOG_THRESHOLD:-150}"

PM2_BIN="$(command -v pm2)"
[ -z "$PM2_BIN" ] && { echo "watchdog: pm2 not on PATH" >&2; exit 1; }

mkdir -p "$(dirname "$LOG_FILE")"
ts="$(date '+%Y-%m-%d %H:%M:%S')"

if [ ! -f "$ERR_LOG" ]; then
  echo "[$ts] err log missing: $ERR_LOG — skip" >> "$LOG_FILE"
  exit 0
fi

# Count matching lines. ⛔ NOT `grep -c ... || echo 0`.
#
# `grep -c` PRINTS "0" *AND* EXITS 1 WHEN THERE ARE NO MATCHES, so the `||` fallback fires
# on top of a count that was already printed and the variable becomes "0\n0". Every numeric
# use of it then throws: `[ "$x" -gt 0 ]` gives "integer expression expected" and `$(( ))`
# gives "syntax error in expression".
#
# THE FAILURE IS PERVERSE: the fallback fires ONLY WHEN THE LOG IS CLEAN, so this watchdog
# worked while the system was sick and broke when it was healthy. Worse, the same construct
# below WROTE the poisoned value into the state file, so one clean cycle poisoned `last`
# permanently: `delta` never computed again and the script logged OK forever — including
# when the poller was genuinely wedged. A self-healing script that disarmed itself the first
# time everything was fine.
#
# ⚠ AND THE LINE BELOW IT IS CORRECT WITH THE SAME IDIOM, WHICH IS WHY THIS SURVIVED REVIEW:
# `cat` on a missing file prints NOTHING and exits 1, so `cat ... || echo 0` yields a single
# "0". The idiom is safe with a command that stays silent on failure and unsafe with one that
# prints anyway. Capture first, then default on the exit code.
current=$(grep -c "telegram-poller.*Poll error\|fetch failed" "$ERR_LOG" 2>/dev/null) || current=0
last=$(cat "$STATE_FILE" 2>/dev/null || echo 0)

# The state file is written by a previous run and read back as a number. VALIDATE IT BEFORE
# ARITHMETIC: a corrupted state file must fail loudly rather than silently degrade to
# always-OK, which is exactly how the poisoned value hid.
case "$current" in ''|*[!0-9]*) echo "[$ts] ERROR: non-numeric match count: $(printf '%q' "$current")" >> "$LOG_FILE"; exit 1;; esac
case "$last" in ''|*[!0-9]*)
  echo "[$ts] ERROR: state file $STATE_FILE is not a number: $(printf '%q' "$last") — refusing to compare and resetting it." >> "$LOG_FILE"
  echo "$current" > "$STATE_FILE"
  exit 1;;
esac
delta=$(( current - last ))

# Handle log rotation (current < last)
[ "$delta" -lt 0 ] && delta="$current"

if [ "$delta" -gt "$THRESHOLD" ]; then
  echo "[$ts] WEDGED: $delta new poller errors since last check (threshold $THRESHOLD). Restarting cortextos-daemon." >> "$LOG_FILE"
  "$PM2_BIN" restart cortextos-daemon --update-env >> "$LOG_FILE" 2>&1
  # After restart, snapshot the new line count so we don't immediately re-fire.
  after=$(grep -c "telegram-poller.*Poll error\|fetch failed" "$ERR_LOG" 2>/dev/null) || after=0
  case "$after" in ''|*[!0-9]*) after="$current";; esac
  echo "$after" > "$STATE_FILE"
else
  echo "[$ts] OK: $delta new poller errors (threshold $THRESHOLD)." >> "$LOG_FILE"
  echo "$current" > "$STATE_FILE"
fi
