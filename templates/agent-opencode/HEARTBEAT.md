# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system. The dashboard monitors your compliance.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

**Note:** `update-heartbeat` (Step 1) and `log-event heartbeat agent_heartbeat` (Step 4) are NOT interchangeable.
- `update-heartbeat` refreshes the dashboard status-string field.
- `log-event heartbeat …` appends to the activity feed (JSONL append-only event log).

Both are required every cycle.

## Step 2: Sweep inbox for un-ACK'd messages

Messages arrive in real time via the fast-checker daemon. This step is a safety sweep for anything that wasn't ACK'd.

Full reference: `plugins/cortextos-agent-skills/skills/comms/SKILL.md`

```bash
cortextos bus check-inbox
```

For any messages returned: process and ACK each one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered after 5 minutes. Target: 0 un-ACK'd after this sweep.

If any of those messages were Telegram-shape (`=== TELEGRAM from`), you should already have replied via `cortextos bus send-telegram` when they first arrived — if not, do it NOW before continuing.

## Step 3: Check task queue + stale task detection

Full reference: `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: complete them, or change the status to match reality (pending if parked, blocked WITH the condition annotated). A note that repeats what the record already says is not an update — it is a keepalive, and it resets the staleness alarm without adding a fact. If nothing has changed and nothing can change, write it in your daily memory, not on the task.
- If you have NO tasks: check GOALS.md for objectives, then message the orchestrator

## Step 4: Log heartbeat event

Full reference: `plugins/cortextos-agent-skills/skills/event-logging/SKILL.md`

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

Full reference: `plugins/cortextos-agent-skills/skills/memory/SKILL.md`

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

- If goals were updated today: you should already have tasks. If not, create them now — see `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`
- If goals are stale (>24h without update): message the orchestrator to request fresh goals
- If you have no goals: message the orchestrator immediately. Don't idle.

## Step 7: Resume work

Full reference: `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`

Pick your highest priority task and work on it. Tasks should trace back to your current goals.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" --result "<summary of what was produced>"
```

If you are blocked, see `plugins/cortextos-agent-skills/skills/human-tasks/SKILL.md` for the human task and approval workflow.
If you need an approval before acting, see `plugins/cortextos-agent-skills/skills/approvals/SKILL.md`.

## Step 8: Guardrail self-check

Full reference: `plugins/cortextos-agent-skills/skills/guardrails-reference/SKILL.md`

Ask yourself: did I skip any procedures this cycle? Did I rationalize not doing something I should have?

If yes, log it:
```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
```

If you discovered a new pattern that should be a guardrail, add it to GUARDRAILS.md now.

## Step 9: Update long-term memory (if applicable)

Full reference: `plugins/cortextos-agent-skills/skills/memory/SKILL.md`

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

## Step 10: Re-ingest memory to knowledge base

Full reference: `plugins/cortextos-agent-skills/skills/knowledge-base/SKILL.md`

Keep your memory collection searchable and current:

```bash
# both-UTC-day-files AND all-or-nothing path set (task_1788799237155_49135842):
#   (a) at a UTC boundary the daily holding the evening's work is no longer "today" — measured
#       2026-09-08, 60 chunks left unsearchable after a fully compliant run;
#   (b) kb-ingest ABORTS THE WHOLE PATH SET if any path is missing (rc=1, nothing ingested at all),
#       and predecessor-absent days are real: 14 of 80 seat-days, ALL SIX seats on 2026-09-02.
# So yesterday's daily is appended ONLY when it exists. BSD date first, GNU fallback.
# Array form on purpose — an empty-string argument aborts the whole ingest (wrapper bug 00011630).
Y="./memory/$(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d yesterday +%Y-%m-%d).md"
# Handoff documents under memory/handoffs/ are EXCLUDED from the knowledge base by chief ruling 2026-09-08 (task 64087460): they restate dailies that are already indexed, and a vector store has no supersession model, so a retired handoff would return with the same confidence as the live one. Never add them to ARGS.
ARGS=(./MEMORY.md "./memory/$(date -u +%Y-%m-%d).md")
[ -f "$Y" ] && ARGS+=("$Y")
cortextos bus kb-ingest "${ARGS[@]}" \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --force
RC=$?; echo "kb-ingest rc=$RC"
[ "$RC" -eq 0 ] || echo "KB INGEST FAILED rc=$RC — outcome UNKNOWN, partial writes possible (no rollback); enumerate the collection before any retry"

# ⛔ v2.1 — THE BLOCK MUST CARRY ITS OWN rc. Without this line the block ENDS on the `|| echo` above,
#    whose echo SUCCEEDS, so a FAILED ingest exits 0. Two seats backgrounded this block and the
#    harness notification said exit 0 for a failed ingest; both read the verdict line by habit rather
#    than by control. The echo stays ABOVE this line — the human-readable reason and the machine
#    status are different channels and both are needed.
# ⚠ CONSEQUENCE, STATED BECAUSE IT IS INTENDED AND LOUD: `exit "$RC"` TERMINATES ANY COMPOUND COMMAND
#    THIS BLOCK IS PASTED INTO. Step 10 is the last executable block in this file (only prose follows),
#    so it truncates nothing here. If you paste this block somewhere else, that is on you.
exit "$RC"
```

This runs automatically on every heartbeat cycle. It ensures past experiences, user preferences, and learned patterns are semantically searchable for future tasks. Skip if GEMINI_API_KEY is not configured.

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
