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

## Step 2: Check inbox

```bash
cortextos bus check-inbox
```

Process ALL messages. ACK every single one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered in 5 minutes. Do not ignore them.
Target: 0 un-ACK'd messages after this step.

## Step 3: System health check (ANALYST — do this before your own tasks)

Full reference: `.claude/skills/agent-management/SKILL.md`

```bash
# Check all agent heartbeats — flag any silent for >5 hours
cortextos bus read-all-heartbeats

# Check for agents with no recent activity
cortextos bus list-tasks --status in_progress 2>/dev/null | head -20
```

For each agent: if heartbeat is older than 5 hours, send a message to that agent:
```bash
cortextos bus send-message <agent_name> normal "Heartbeat check: are you running? Last heartbeat was more than 5 hours ago."
```

If an agent is unresponsive for >8 hours, notify the orchestrator and log the issue:
```bash
cortextos bus send-message $CTX_ORCHESTRATOR_AGENT normal "Agent <name> appears unresponsive — last heartbeat >8h ago. May need restart."
cortextos bus log-event action agent_unresponsive warning --meta '{"agent":"<name>","hours_silent":8}'
```

## Step 3b: Check own task queue + stale task detection

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: complete them, or change the status to match reality (pending if parked, blocked WITH the condition annotated). A note that repeats what the record already says is not an update — it is a keepalive, and it resets the staleness alarm without adding a fact. If nothing has changed and nothing can change, write it in your daily memory, not on the task.
- If you have NO tasks: check GOALS.md for objectives, then message the orchestrator

Stale tasks are visible on the dashboard. They make you look broken.

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

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

Read GOALS.md for any new objectives from the user.
If goals changed since last check, create tasks to address them:

```bash
cortextos bus create-task "<title>" --desc "<description>" --assignee $CTX_AGENT_NAME --priority normal
```

## Step 7: Resume work

Pick your highest priority task and work on it.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" "<summary of what was produced>"
```

## Step 8: Update long-term memory (if applicable)

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

## Step 9: Re-ingest memory to knowledge base

> ⚠ **NUMBERED 9 HERE, AND THE FLEET CALLS IT "THE STEP-10 BLOCK".** That is not a mistake in
> either place: this variant's step list ends at 8, while `agent`, `agent-codex`, `agent-opencode`,
> `hermes` and `orchestrator` carry a guardrail self-check that this one does not, which puts the
> same block at 10 there. **The number is a position in a file, not a name for the block.** Numbering
> it 10 here to match the fleet's phrase would leave a file whose steps run 1, 2, 3, 3b, 4-8, 10.

Full reference: `.claude/skills/knowledge-base/SKILL.md`

Keep your memory collection searchable and current:

```bash
# both-UTC-day-files AND all-or-nothing path set:
#   (a) at a UTC boundary the daily holding the evening's work is no longer "today" — measured
#       2026-09-08, 60 chunks left unsearchable after a fully compliant run;
#   (b) kb-ingest ABORTS THE WHOLE PATH SET if any path is missing (rc=1, nothing ingested at all),
#       and predecessor-absent days are real: 14 of 80 seat-days, all six seats on 2026-09-02.
# So yesterday's daily is appended ONLY when it exists. BSD date first, GNU fallback.
# Array form on purpose — an empty-string argument aborts the whole ingest.
Y="./memory/$(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d yesterday +%Y-%m-%d).md"
# Handoff documents under memory/handoffs/ are EXCLUDED from the knowledge base by chief ruling
# 2026-09-08: they restate dailies that are already indexed, and a vector store has no supersession
# model, so a retired handoff would return with the same confidence as the live one. Never add them.
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
#    THIS BLOCK IS PASTED INTO. If you paste this block somewhere else, that is on you.
# ⛔ THE CLAIM THAT MAKES THAT SAFE IS PER-FILE, SO HERE IS THE CHECK RATHER THAN THE CONCLUSION:
#    no ```bash fence follows this line in THIS file — only prose — so it truncates nothing here.
#    `awk 'NR>ex && /^```bash/' <this file>` returns empty. IT DOES NOT IN `templates/hermes`, where
#    two blocks follow and the line is a subshell for that reason. A CLAUSE COPIED ACROSS FILES MAKES
#    A CLAIM ABOUT EACH OF THEM: re-run the check before trusting it in a new variant.
exit "$RC"
```

This runs automatically on every heartbeat cycle. It ensures past experiences, user preferences, and learned patterns are semantically searchable for future tasks. Skip if GEMINI_API_KEY is not configured.

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
