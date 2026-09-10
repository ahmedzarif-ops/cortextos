# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system. The dashboard monitors your compliance.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

**Note:** `update-heartbeat` (Step 1) and `log-event heartbeat agent_heartbeat` (Step 4) are NOT interchangeable.
- `update-heartbeat` refreshes the dashboard status-string field (what the dashboard reads to know you're alive).
- `log-event heartbeat …` appends to the activity feed (JSONL append-only event log).

Both are required every cycle. Skipping Step 1 leaves your dashboard view stale even though you're firing events.

## Step 2: Sweep inbox for un-ACK'd messages

Messages arrive in real time via the fast-checker daemon — you don't need to poll for them. This step is a safety sweep for anything that wasn't ACK'd (e.g. a crash mid-processing).

Full reference: `.claude/skills/comms/SKILL.md`

```bash
cortextos bus check-inbox
```

For any messages returned: process and ACK each one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered after 5 minutes. Target: 0 un-ACK'd after this sweep.

## Step 3: Check task queue + stale task detection

Full reference: `.claude/skills/tasks/SKILL.md`

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: complete them, or change the status to match reality (pending if parked, blocked WITH the condition annotated). A note that repeats what the record already says is not an update — it is a keepalive, and it resets the staleness alarm without adding a fact. If nothing has changed and nothing can change, write it in your daily memory, not on the task.
- If you have NO tasks: check GOALS.md for objectives, then message the orchestrator

Stale tasks are visible on the dashboard. They make you look broken.

## Step 4: Log heartbeat event

Full reference: `.claude/skills/event-logging/SKILL.md`

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

Full reference: `.claude/skills/memory/SKILL.md`

```bash
TODAY=$(date -u +%Y-%m-%d)
LOCAL_TIME=$(date +'%-I:%M %p %Z' 2>/dev/null || date)
MEMORY_DIR="$(pwd)/memory"
mkdir -p "$MEMORY_DIR"
printf '\n## Heartbeat Update - %s / %s\n' "$(date -u +'%H:%M UTC')" "$LOCAL_TIME" >> "$MEMORY_DIR/$TODAY.md"
cat >> "$MEMORY_DIR/$TODAY.md" << 'MEMORY'

- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Check GOALS.md

Read GOALS.md. Goals are refreshed daily by the orchestrator each morning.

- If goals were updated today: you should already have tasks. If not, create them now — see `.claude/skills/tasks/SKILL.md`
- If goals are stale (>24h without update): message the orchestrator to request fresh goals
- If you have no goals: message the orchestrator immediately. Don't idle.

## Step 7: Resume work

Full reference: `.claude/skills/tasks/SKILL.md`

Pick your highest priority task and work on it. Tasks should trace back to your current goals.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" --result "<summary of what was produced>"
```

If you are blocked, see `.claude/skills/human-tasks/SKILL.md` for the human task and approval workflow.
If you need an approval before acting, see `.claude/skills/approvals/SKILL.md`.

## Step 8: Guardrail self-check

Full reference: `.claude/skills/guardrails-reference/SKILL.md`

Ask yourself: did I skip any procedures this cycle? Did I rationalize not doing something I should have?

If yes, log it:
```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
```

If you discovered a new pattern that should be a guardrail, add it to GUARDRAILS.md now.

## Step 9: Update long-term memory (if applicable)

Full reference: `.claude/skills/memory/SKILL.md`

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

## Step 10: Re-ingest memory to knowledge base

Full reference: `.claude/skills/knowledge-base/SKILL.md`

Keep your memory collection searchable and current:

```bash
# ══ Step 10 KB ingest — v2 ══
# v1 → v2: today's daily is APPENDED ONLY IF PRESENT and its absence is reported as a FINDING;
#          a guardrail event fires on the absent branch; GUARDRAILS.md is ingested only when its
#          CONTENT changed; the stamp is written only after a successful ingest.

# Array form on purpose — an empty-string argument aborts the whole ingest.
ARGS=(./MEMORY.md)

# ── today's daily MUST already exist: STEP 5 creates it. Step 10 only DETECTS its absence. ──
# kb-ingest ABORTS THE WHOLE PATH SET on one missing path (rc=1, NOTHING written) while any gate
# line above it still reads healthy ⇒ A PASS UPSTREAM OF AN ABORT READS AS A PASS.
# The live case is the FIRST HEARTBEAT AFTER A UTC BOUNDARY: "today" is a date with no file yet.
# Measured 2026-09-10 across the deployed agents: one had a daily only because of post-midnight
# appends and another had none at all, and that run would have written NOTHING behind a healthy
# "CHANGED" line. v2.1's `exit "$RC"` makes it loud — but it is attributed as "ingest failed",
# NOT as "Step 5 never ran", which is the fact a reader needs. Hence the explicit finding below.
TD="./memory/$(date -u +%Y-%m-%d).md"
if [ ! -f "$TD" ]; then
  echo "STEP-10 FINDING: $TD ABSENT — STEP 5 DID NOT RUN THIS CYCLE. This is a FINDING, not a skip."
  echo "  DO NOT create an empty file to make the ingest pass: the absence IS the evidence."
  echo "  Ingesting the paths that DO exist; today's work is UNSEARCHABLE until Step 5 runs."
  # Unmissable WITHOUT overloading rc — rc must keep meaning "the ingest failed".
  cortextos bus log-event action guardrail_triggered info \
    --meta '{"agent":"'$CTX_AGENT_NAME'","guardrail":"step5-skipped-daily-absent","context":"step 10 found today daily absent; ingested surviving paths only"}'
else
  ARGS+=("$TD")
fi

# Yesterday's daily appended ONLY when it exists — predecessor-absent days are real (measured: 14 of
# 80 agent-days, and every agent on one of them). BSD date first, GNU fallback.
Y="./memory/$(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d yesterday +%Y-%m-%d).md"
[ -f "$Y" ] && ARGS+=("$Y")
# Handoffs under memory/handoffs/ are EXCLUDED: they restate dailies that are already indexed, and a
# vector store has no supersession model, so a retired handoff would come back with the same
# confidence as the live one. Never add them to ARGS.

# ── GUARDRAILS.md joins ARGS ONLY WHEN CHANGED ──
# ⛔ THE GATE IS sha256 (CONTENT), NEVER mtime. `-nt` is the obvious implementation and it is WRONG:
#    a checkout, a branch switch or a state sync all bump mtime while rewriting bytes identically,
#    which would re-embed the whole file every cycle — the exact spend this gate exists to prevent.
#    `touch` -> SKIPPED is the proof the gate is content-addressed; load-bearing, not a footnote.
GR="./GUARDRAILS.md"
GR_STAMP="${CTX_ROOT}/state/${CTX_AGENT_NAME}/.kb-guardrails-sha256"
GR_IN_ARGS=0
if [ -f "$GR" ]; then
  GR_NOW=$(shasum -a 256 "$GR" 2>/dev/null | awk '{print $1}')
  [ -n "$GR_NOW" ] || GR_NOW=$(sha256sum "$GR" | awk '{print $1}')
  GR_WAS=$(cat "$GR_STAMP" 2>/dev/null || true)
  if [ "$GR_NOW" != "$GR_WAS" ]; then
    ARGS+=("$GR"); GR_IN_ARGS=1
    echo "GUARDRAILS: CHANGED -> ingesting (was=${GR_WAS:-<no stamp>} now=$GR_NOW)"
  else
    echo "GUARDRAILS: unchanged -> skipped (sha $GR_NOW)"
  fi
else
  echo "GUARDRAILS: FILE ABSENT — not added; this is a FINDING, not a skip"
fi

# ⛔ NEVER PIPE THE INGEST. `RC=$?` after a pipe is the LAST command's status, so a piped ingest turns
#    stamp-after-success into stamp-after-tail-succeeded — unconditional, which silently converts the
#    crash-consistent ordering below into NO ordering at all. Two agents hit this within one hour,
#    one piping through `tail` and one reading rc from `cut`: same mechanism, different command.
cortextos bus kb-ingest "${ARGS[@]}" \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --force
RC=$?; echo "kb-ingest rc=$RC"

# ⛔ STAMP AFTER SUCCESS ONLY — CRASH-CONSISTENCY, NOT TIDINESS. Proven by a real kill: a daemon
# restart killed an ingest MID-EMBED; because the stamp writes only on rc=0 it stayed absent and the
# next cycle re-ingested. Had it stamped first, the file would read as indexed while never landing,
# and this gate would answer "unchanged -> skipped" FOREVER — a silent, permanent gap.
if [ "$GR_IN_ARGS" -eq 1 ] && [ "$RC" -eq 0 ]; then
  printf '%s' "$GR_NOW" > "$GR_STAMP"; echo "GUARDRAILS stamp updated -> $GR_NOW"
elif [ "$GR_IN_ARGS" -eq 1 ]; then
  echo "GUARDRAILS stamp NOT updated (rc=$RC) — will retry next cycle, by design"
fi
[ "$RC" -eq 0 ] || echo "KB INGEST FAILED rc=$RC — outcome UNKNOWN, partial writes possible (no rollback); enumerate the collection before any retry"

# ⛔ v2.1 — THE BLOCK MUST CARRY ITS OWN rc. Without this line the block ENDS on the `|| echo` above,
#    whose echo SUCCEEDS, so a FAILED ingest exits 0. Two seats backgrounded this block and the
#    harness notification said exit 0 for a failed ingest; both read the verdict line by habit rather
#    than by control. The echo stays ABOVE this line — the human-readable reason and the machine
#    status are different channels and both are needed.
# ⚠ CONSEQUENCE, STATED BECAUSE IT IS INTENDED AND LOUD: `exit "$RC"` TERMINATES ANY COMPOUND COMMAND
#    THIS BLOCK IS PASTED INTO. If you paste this block somewhere else, that is on you.
# ⛔ THE CLAIM THAT MAKES THAT SAFE IS PER-FILE, SO HERE IS THE CHECK RATHER THAN THE CONCLUSION:
#    no ```bash fence follows this line in THIS file — only prose — so it truncates nothing here.
#    `awk 'NR>ex && /^```bash/' <this file>` returns empty. IT DOES NOT IN `templates/hermes`, where two
#    blocks follow and the line is a subshell for that reason. A CLAUSE COPIED ACROSS FIVE FILES MAKES A
#    CLAIM ABOUT EACH OF THEM, and this one was true of four: re-run the check before trusting it in a
#    sixth. (found in review, 2026-09-10)
exit "$RC"
```

This runs automatically on every heartbeat cycle. It ensures past experiences, user preferences, and learned patterns are semantically searchable for future tasks. Skip if GEMINI_API_KEY is not configured.

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
