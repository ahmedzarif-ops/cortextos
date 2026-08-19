---
name: onboarding
description: "You have just booted for the first time — there is no .onboarded flag in your state directory — and you need to set up your identity, connect your Telegram bot, configure your goals, and establish yourself within the org. Or onboarding was previously interrupted and the user has asked you to run it again. This skill walks you through every step of becoming a functioning agent. Do not skip steps. Do not start normal operations until onboarding is complete."
triggers: ["onboarding", "/onboarding", "first boot", "run onboarding", "setup", "not onboarded", "configure agent", "set up identity", "establish identity", "set goals", "onboard me", "start onboarding", "redo onboarding", "onboarding interrupted", "first time setup", "initial setup", "agent setup"]
external_calls: []
---

# Onboarding

This skill runs on first boot or when explicitly triggered. It is the only thing you should do until it is complete.

## Native host contract

Use the harness's file read/write tools for file operations and the `cortextos`
Node CLI for Cortext operations. Detect the host with `node -p
"process.platform"` only when needed. On native Windows use PowerShell; never
assume Bash, WSL, Git Bash, POSIX utilities, Unix paths, or symlink privileges.
Any shell examples in the role's `ONBOARDING.md` describe the intended
operation: translate them yourself to native PowerShell/file tools and never
ask the user to perform that translation.

## Conversation turn gate

On Telegram, ask exactly one question per agent turn. After sending a message
that contains a question, stop all tool calls and end the turn immediately.
Do not send the next numbered onboarding prompt until a new inbound user
message arrives. On that next turn, continue from the earliest unanswered item.
This gate overrides any grouping of questions in `ONBOARDING.md`.

---

## Step 0: Detect your runtime

Read `config.json` to find your runtime — it determines where your skills live, which slash-commands exist, and which env vars matter.

Read and parse `config.json` with the harness file/JSON tools. Use its `runtime`
string, defaulting to `claude-code` only when the field is absent or empty. Do
not parse JSON with `grep`/`sed` on Windows.

Branch the rest of onboarding on this value:

| Runtime | Skills location | Slash-commands available | Auth env var |
|---|---|---|---|
| `claude-code` (default) | `.claude/skills/<skill>/SKILL.md` | `/loop`, `/usage`, `/compact`, etc. | `CLAUDE_CODE_OAUTH_TOKEN` |
| `codex-app-server` | `plugins/cortextos-agent-skills/skills/<skill>/SKILL.md` (linked into `~/.codex/skills/<agent>__<skill>`) | none — codex has no slash-command surface | `CODEX_API_KEY` (or codex login) |
| `hermes` | hermes-specific (see hermes adapter docs) | none | hermes-specific |

If `runtime` is missing or empty, treat it as `claude-code` (legacy default).

---

## Step 1: Check onboarding status

Check for `.onboarded` under the native path formed from `CTX_ROOT`, `state`,
and `CTX_AGENT_NAME` with the harness filesystem tools.

If already `ONBOARDED`, skip to normal session start. Do not re-run onboarding unless the user explicitly requests it.

---

## Step 2: Read ONBOARDING.md

Read `ONBOARDING.md` with the harness file tool.

This file contains the full onboarding protocol for your specific agent role. Follow every step exactly. Do not improvise.

---

## Step 3: What onboarding establishes

Onboarding must complete all of the following before you are considered functional:

| Item | File written |
|------|-------------|
| Your name, role, emoji, and identity | `IDENTITY.md` |
| Your behavior, autonomy rules, and mode | `SOUL.md` |
| Your current goals and focus | `GOALS.md` |
| User preferences and context | `USER.md` |
| Guardrails and patterns to avoid | `GUARDRAILS.md` |
| Telegram bot connected and tested | `.env` (BOT_TOKEN, CHAT_ID) |
| Crons configured and running | `config.json` |
| .onboarded flag written | `$CTX_ROOT/state/$CTX_AGENT_NAME/.onboarded` |

---

## Step 3b: External Persistent Crons

Your crons survive restarts automatically. No manual restoration needed.

When you set up recurring workflows during onboarding, add them as persistent crons:

```bash
# Example: heartbeat every 6h
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 6h Read HEARTBEAT.md and follow its instructions.
```

The daemon reads `${CTX_ROOT}/state/${CTX_AGENT_NAME}/crons.json` on every start and re-schedules all entries. Your crons will fire even after crashes or hard restarts.

Use `cortextos bus add-cron` for any workflow that must keep running across restarts. (Claude-Code-runtime agents: do NOT use `/loop` for persistent scheduling — it is session-only and dies on restart. Codex-runtime agents have no `/loop` to begin with; `add-cron` is the only path.)

For full details, see the `## External Persistent Crons` section in `AGENTS.md`.

---

## Step 4: Mark complete

When all steps in ONBOARDING.md are done:

Create the native state directory recursively and then create the empty
`.onboarded` marker with the harness filesystem tools. On Windows the native
fallback is `New-Item -ItemType Directory -Force` followed by `New-Item
-ItemType File -Force`; do not run `mkdir -p` or `touch`.

Then notify the user via Telegram that you are online and ready.

---

## If Onboarding Is Interrupted

If a session crash or restart interrupts onboarding mid-way:

1. Check which steps completed (look at which files exist)
2. Resume from the first incomplete step
3. Do NOT restart from the beginning if some steps already completed
4. Re-run `/onboarding` if needed to trigger this skill again

---

## Critical Rules

- Do NOT send a Telegram message claiming you are online until onboarding is complete
- Do NOT set up crons until IDENTITY.md and GOALS.md are written
- Do NOT start processing user requests until `.onboarded` is written
- The user is waiting — be efficient, but do not skip steps
