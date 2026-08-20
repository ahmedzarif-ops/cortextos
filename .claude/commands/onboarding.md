---
name: onboarding
description: Interactive onboarding for cortextOS Node.js - walks through full setup from zero to a running multi-agent system
---

You are guiding the user through a complete interactive onboarding for cortextOS (Node.js version). Walk through each phase **in order**, checking results before proceeding. Explain everything in casual plain English. If any step fails, diagnose and fix before moving on. You must go through every step even if diverted mid step by the user. No exceptions. 

**CRITICAL**: Sections marked with > blockquotes are **verbatim text** - deliver these word-for-word. Do not skip or paraphrase them.

**CRITICAL**: The more context the user provides, the better the system performs from day one. Encourage them to elaborate. Do not rush.

## Cross-platform execution contract

This onboarding supports native Windows, macOS, and Linux. Before running any
other command, detect the host exactly once with:

```text
node -p "process.platform"
```

If the result is `win32`, use the Read tool directly on the exact
repository-relative path `references/onboarding-windows.md` and read it
completely before Phase 2. If the tool requires an absolute path, prepend the
current workspace root. Do not use Glob, `find`, or any shell command to locate
this known file. Use it as the operational implementation for every OS-specific
step. Keep
this file as the single conversational flow: preserve its questions, verbatim
text, ordering, pacing, validation, and completion gates. Do not execute or
show the macOS/Linux command blocks and do not ask the user to translate them.
The reference owns the Windows operations `Start-Process http://localhost:3000`,
`Get-NetTCPConnection -LocalPort 3000`, and
`scripts\install-windows-pm2-startup.ps1`, including its rule to
never run `pm2 startup` on Windows; their presence here is routing metadata, not a second
implementation.

For `darwin` or `linux`, do not load the Windows reference. The existing
macOS/Linux commands and behavior below remain authoritative.

Prefer the Read, Write, Edit, Glob, and JSON-aware tools of the active agent
harness over shell text processing on every platform.

Shell variables do not reliably persist between agent tool calls. Retain
`INSTANCE_ID`, `CTX_ROOT`, `ORG_NAME`, and agent names in the onboarding state,
pass literal `--instance`/`--org` values on every CLI command, and set the
required environment again in the same command that starts PM2.

---

## Phase 1: Welcome

### 1a. Welcome

> "cortextOS is a system for running persistent 24/7 Claude Code agents. Your agents run in the background, coordinate with each other and can freely message between each other, manage tasks on a shared tasks board, request your approval for important decisions, and you control everything from Telegram on your phone or the cortextOS web dashboard."

> "Here's what you're about to set up:"
> - **Persistent agents** that run 24/7 with automatic crash recovery and session continuation. Each agent is a full Claude Code CLI session.
> - **Telegram control** - text back and forth with your agents from your phone with full Claude Code capabilities.
> - **Organizations** - groups of agents working together toward shared goals. Create as many organizations as you want and switch between them in the dashboard.
> - **Task management** - agents create, assign, and complete tasks visible on a dashboard.
> - **Approval workflows** - agents request your sign-off before taking high-stakes actions. Agents can also assign you tasks when they need your help.
> - **Analytics** - cost tracking, task throughput, agent effectiveness metrics for optimization.
> - **Web dashboard** - real-time monitoring of your entire system in a browser.
> - **Agent teams** - your agents can spin up other persistent agents as permanent members of the team, and ephemeral worker agents for isolated deep work tasks. Agents can manage other agents as many layers deep as you want.
> - **Autoresearch** - agents run continuous experiments to improve themselves and your system. Measure outcomes, learn, propose changes - all gated by your approval.
> - **Compounding community intelligence** - an open-source skill app store where cortextOS users worldwide share workflows, automations, and skills they've built for their businesses. Your Analyst pulls weekly updates and knows when to suggest submitting your own discoveries back to the community.
> - **Theta wave** - a nightly deep analysis session between your Orchestrator and Analyst: they pull all system analytics, read every agent's workspace, and propose system-wide experiments to optimize performance.
> - **Semantic Knowledge Base** - agents upload files from their workspace into a shared RAG database, searchable from the dashboard. Supports docs, images, audio, video - anything you want them to store as long-term shared memory.
> - **Native iPhone App** *(coming soon)* - dashboard + Telegram in one app with push notifications and full system control from your phone.
> - **Full codebase access** - agents can read and write your dashboard, core scripts, and the markdown files that define their own behavior. They can build custom dashboard pages for your business and eventually extend the iPhone app.

> "Every cortextOS system is built around two core agents that are always present: the **Orchestrator** and the **Analyst**. They are the two halves of your cortextOS brain."
>
> "The **Orchestrator** is the leader. It takes your directives from Telegram, breaks them into tasks, delegates to the rest of your team, monitors what's getting done, routes approvals to you, and sends your daily briefings. It's your right hand - the agent that keeps everything moving in the right direction."
>
> "The **Analyst** is the optimizer. It watches the entire system from the outside - tracking metrics, reading every agent's workspace, spotting bottlenecks and anomalies, and running the theta wave each night. It doesn't execute work; it makes the whole system better at executing work. Think of it as the CTO of your AI team."
>
> "Together they run a continuous improvement loop while you sleep: the Orchestrator drives execution, the Analyst measures outcomes and proposes experiments, and every proposed change comes to you for approval before it goes live. The system gets smarter every week without you having to manage it."
>
> "Every specialist agent you add reports up to the Orchestrator. The Analyst watches all of them. The deeper your team grows, the more leverage these two give you."

> "Here's how it works under the hood: A Node.js daemon manages your agents as persistent processes. Each agent is a Claude Code session running in a PTY - it reads its own markdown files (identity, goals, soul, heartbeat), sets up scheduled tasks, and communicates via a file-based message bus. You talk to agents over Telegram via their own bots. Everything is logged, monitored, and visible on a dashboard."

> "The setup flow: I'll help you configure the technical infrastructure here in Claude Code. Then your Orchestrator agent will come online in Telegram and walk you through its own setup - role confirmation, goals, cron schedule, communication preferences. At the end of that, the Orchestrator will walk you through creating a Telegram bot for your Analyst agent. The Analyst then does its own Telegram onboarding - monitoring setup, theta wave config, ecosystem preferences. Once that's done, the Analyst will recommend specialist agents based on your goals, and the Orchestrator handles creating each one. You'll just need to create a Telegram bot for each new agent via @BotFather."

Ask: "Ready to get started? And - do you already have a Telegram bot token ready, or do we need to create one? While you answer, I will set up the dependencies"

---

## Phase 2: Dependency Check

Check and auto-install all dependencies. Do not ask permission - just install what is missing.

**Windows:** perform W1 of the loaded Windows reference as the sole Phase 2
dependency and authentication check, then resume at Phase 3. Do not execute any
other command in this phase on Windows. W1 defines the actual native core
prerequisites and the active-session authentication proof; do not spawn a nested
Claude auth probe or substitute the macOS/Linux list below.

**macOS/Linux only — first verify Claude Code is authenticated** - the default core agents run as Claude Code sessions and require a valid login:
```text
claude --version
claude auth status
```
If the command fails or shows an auth error:
> "Claude Code is not authenticated. Run `claude login` in your terminal to sign in, then restart this Claude Code session."

Do not proceed until Claude Code is authenticated.

**macOS/Linux:** check each dependency with its native version/status command
and use `command -v <name>` if a command is missing.

```text
node --version
npm --version
claude --version
pm2 --version
jq --version
curl --version
```

For any missing dependency, install using the appropriate package manager:

**macOS:**
- `node` / `npm`: `brew install node`
- `jq`: `brew install jq`

**Linux (Debian/Ubuntu):**
- `node` / `npm`: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs`
- `jq`: `sudo apt-get install -y jq`

**macOS/Linux:**
- `pm2`: `npm install -g pm2`
- `claude`: Tell user to install from https://docs.anthropic.com/en/docs/claude-code - cannot be auto-installed

Verify Node is v20+:
```text
node --version
```

If `pm2` is not installed, install it:
```text
npm install -g pm2
```

---

## Phase 3: Install

**Windows:** use W2 of the loaded Windows reference for build inspection,
install/test/build, native instance paths, and state/JSON operations. Continue
to apply every shared verification and failure gate in this phase.

**macOS/Linux:** check if already installed by inspecting `dist/cli.js` with
the harness file tools.

If not built:
```text
npm ci
npm run build
```

Run the test suite to verify the build is healthy:
```text
npm test
```

**VERIFY**: All tests must pass before proceeding. If any fail, surface the failures:
> "Some tests failed. This usually means a dependency issue or a platform incompatibility. Let's fix it before moving on."

Diagnose and fix any failures, then re-run until clean.

Then run install:
```text
node dist/cli.js install
```

Or if the user has `cortextos` in their PATH:
```text
cortextos install
```

**Do not ask the user about instance names.** Auto-assign one silently:

Use the harness file/JSON tools to inspect `$HOME/.cortextos`. Reuse `default`
only when its `config/enabled-agents.json` is an empty object. Otherwise choose
the first absent `cortextosN` directory. Do not make the user choose the ID and
do not implement this selection with shell parsing.

**IMPORTANT:** Every `node dist/cli.js <subcommand>` call below MUST include
`--instance "${INSTANCE_ID}"` (and `--org "${ORG_NAME}"` where the command
takes one). The CLI subcommands default the instance to literal `'default'` if
neither the flag nor the `CTX_INSTANCE_ID` env var is set. Forgetting the flag
silently writes to the wrong instance dir, splitting the agent registration
across multiple `~/.cortextos/<instance>/` trees. Always pass the flags.

Do not rely on exported variables surviving between tool calls. Pass the
instance explicitly on every CLI command. When PM2 is started in Phase 9, set
`CTX_INSTANCE_ID`, `CTX_ROOT`, and `PM2_HOME` in that same shell invocation.

---

## Phase 4: Organization Setup

### 4a. Explain Organizations (verbatim)

> "cortextOS organizes your agents into Organizations. An Organization is a group of agents that work together toward shared goals - for your business, a side project, or any domain of your life. Each org has its own task queue, approval workflow, analytics, set of dashboard pages, and shared context."

### 4b. Gather Organization context

Ask these questions one at a time. Follow up on interesting answers. Let the user elaborate.

1. "The more detail and context you give me during onboarding, the better cortextOS will work from day one. What will this Organization be for? Describe it in a sentence or two."
2. "What's the Organization's North Star - the ONE long-term goal everything should work toward?"
3. "Based on that, what do you want to call this Organization?" (lowercase, hyphens OK - e.g., `mycompany`, `acme`, `demo`)

**Validate**: Convert to lowercase, replace spaces with hyphens, strip characters that are not `a-z`, `0-9`, or `-`. Show the cleaned name and confirm.

4. "What are the top 1-3 goals right now to move toward that?"
5. "What's the single most important thing to get done this week? One sentence." (this becomes `daily_focus`)
6. "What's your timezone?" (auto-detect with the runtime via
   `node -p "Intl.DateTimeFormat().resolvedOptions().timeZone"`)
7. "What are your working hours? This sets when agents are in day mode (responsive, follows your direction) vs night mode (proactive, works autonomously). For example: 8am to midnight, 9am to 6pm." Default to 08:00-00:00 if they don't have a preference.
8. "What communication style should your agents have? Casual / professional / technical?"

### 4c. Create Organization

**Windows:** use the explicit native CLI form in W2 of the loaded Windows
reference and the harness JSON operations described there.

**macOS/Linux:**

```bash
ORG_NAME="<validated org name>"
node dist/cli.js init "${ORG_NAME}" --instance "${INSTANCE_ID}"
```

This creates `orgs/${ORG_NAME}/` with context.json, goals.json, and knowledge.md.

Update `orgs/${ORG_NAME}/context.json` with the gathered context (use the Write tool):
```json
{
  "name": "<org name>",
  "description": "<user's description>",
  "timezone": "<IANA timezone>",
  "day_mode_start": "<HH:MM, e.g. 08:00>",
  "day_mode_end": "<HH:MM, e.g. 00:00>",
  "communication_style": "<casual|professional|technical>",
  "orchestrator": ""
}
```

Update `orgs/${ORG_NAME}/goals.json`:
```json
{
  "north_star": "<their north star answer>",
  "daily_focus": "<their answer to question 5>",
  "daily_focus_set_at": "<current ISO timestamp>",
  "goals": ["<goal 1>", "<goal 2>", "<goal 3>"],
  "bottleneck": "",
  "updated_at": "<current ISO timestamp>"
}
```

### 4d. Knowledge Base

Ask:
> "Let's set up your org's shared knowledge file. This is context that all your agents read on every boot. Tell me:"
> 1. "Your business or project - what does it do, key products/services, model?"
> 2. "Your team - key people and roles (human or AI, we will set up your other agents later)"
> 3. "Technical setup - existing projects on this computer or elsewhere, repos, infrastructure, tools, key services"
> 4. "Important links - dashboards, docs, tools"
> 5. "Any key decisions or context agents should know?"

Write the answers to `orgs/${ORG_NAME}/knowledge.md`. If answers are sparse, that's fine - agents will add to it.

---

## Phase 5: Agent Planning

### 5a. Explain the team roles (verbatim)

> "Every Organization has two core roles: the **Orchestrator** and the **Analyst**."
>
> "The **Orchestrator** is your right hand - takes your directives, decomposes them into tasks, delegates to specialist agents, monitors progress, routes approvals, sends you briefings. It coordinates; it doesn't do specialist work itself."
>
> "The **Analyst** is your system optimizer - monitors agent health, collects metrics, detects anomalies, proposes improvements. Think of it as the CTO of your AI team."
>
> "Beyond these two, you can add specialist agents later through your Orchestrator on Telegram."

### 5b. Get agent names

Ask: "What do you want to call your Orchestrator?" (suggest something org-appropriate - e.g., `commander`, `coordinator`, `chief`)

**Validate**: lowercase, hyphens, no special chars. Confirm with user.

Ask: "What do you want to call your Analyst?" (suggest: `analyst`, `sentinel`, `monitor`, `watchdog`)

**Validate**: same rules. Confirm.

Store: `ORCH_NAME` and `ANALYST_NAME`

---

## Phase 6: Orchestrator Setup

### 6a. Telegram Bot Setup

Walk through step by step:

1. "Open Telegram on your phone or desktop"
2. "Search for **@BotFather** and start a chat"
3. "Send `/newbot`"
4. "Give it a display name (e.g., 'MyOrg Orchestrator')"
5. "Give it a username that ends in 'bot' (e.g., 'myorg_commander_bot')"
6. "BotFather will reply with an HTTP API token - paste it here"
7. Click the t.me link BotFather provides you to open the chat with your new agent. 

After token paste, create the agent directory before polling so the token can be
stored in its permission-restricted, Git-ignored `.env` instead of appearing in
a shell command:

```text
node dist/cli.js add-agent <orchestrator-name> --template orchestrator --org <org-name> --instance <instance-id>
```

Use the Write tool to set only `BOT_TOKEN=<pasted token>`, `CHAT_ID=`, and
`ALLOWED_USER=` in the new agent `.env`. Never print the token or put it in a
command-line argument. `add-agent` establishes mode `0600` on Unix and an
owner/SYSTEM-only ACL on Windows.

Then tell the user: "Now send any message to your new bot on Telegram (just 'hi' is fine). This lets me detect your chat ID so that only you can message your agent. You can configure other chat IDs later so other members of your team can use cortextOS as well."

**CRITICAL — BUG-033 fix**: Do NOT wait for the user to type a confirmation in chat before running the polling curl below. Start the long-poll IMMEDIATELY after delivering the instruction. The poll uses `timeout=30` which blocks for up to 30 seconds waiting for a Telegram message — that IS the user's confirmation. If you wait for typed confirmation first, the poll starts too late and may miss the very first message a user sends to a brand-new bot (Telegram's `getUpdates` first-message-lost trap, BUG-023). The correct sequence is: deliver the instruction, then immediately run the curl loop in the same response.

Use long polling (timeout=30) so Telegram holds the connection open until a message arrives instead of returning empty immediately. Read the token from the restricted `.env`; do not interpolate it into the logged command.

**Windows:** use W3 of the loaded Windows reference. It implements this exact
long-poll timing and credential boundary natively; do not translate the block
below.

**macOS/Linux:**

```bash
AGENT_ENV="orgs/${ORG_NAME}/agents/${ORCH_NAME}/.env"
ORCH_BOT_TOKEN=$(awk -F= '/^BOT_TOKEN=/{print substr($0,index($0,"=")+1); exit}' "$AGENT_ENV")
for i in 1 2 3; do
    CHAT_INFO=$(curl -s "https://api.telegram.org/bot${ORCH_BOT_TOKEN}/getUpdates?timeout=30")
    ORCH_CHAT_ID=$(echo "$CHAT_INFO" | jq -r '.result[0].message.chat.id // empty')
    ORCH_USER_ID=$(echo "$CHAT_INFO" | jq -r '.result[0].message.from.id // empty')
    [[ -n "$ORCH_CHAT_ID" ]] && break
    sleep 5
done
```

If ORCH_CHAT_ID is empty after 3 retries, tell user to send another message and try again. Do not proceed until it's a valid number.

**Do NOT flush the Telegram offset** - the agent should see the user's first message when it boots.

### 6b. Finalize Agent Credentials

Use the Write/Edit tool—not shell redirection—to update the already-created
`.env` with `BOT_TOKEN`, `CHAT_ID`, and `ALLOWED_USER`. Preserve its restricted
permissions. Never include the token in a report, screenshot, diagnostic, or
Git diff.

Update `config.json` with agent name:
read the JSON with the harness file tool, set `agent_name`, and write valid
formatted JSON atomically. Do not use a `/tmp` + `jq` shell rewrite.

### 6c. Model Selection

Ask: "Which Claude model should your Orchestrator use? Recommended: `claude-opus-4-6` for the Orchestrator (most capable), `claude-sonnet-4-6` for worker agents (faster, cheaper)."

Update the same parsed JSON with the selected model using the harness file tool.

**Note:** Everything else - identity, personality, working hours, autonomy level, approval policy, cron schedule, USER.md - is configured by the Orchestrator itself during its Telegram onboarding. The template provides sensible defaults; the agent rewrites them with real content.

### 6d. Enable Orchestrator

```text
node dist/cli.js enable <orchestrator-name> --org <org-name> --instance <instance-id>
```

Verify:
read the selected instance's `config/enabled-agents.json` as JSON and verify the
orchestrator entry is enabled.

---

## Phase 7: Dashboard Setup

### 7a. Explain (verbatim)

> "Let's prepare the web dashboard - this is your real-time view of all agents, tasks, approvals, costs, and analytics. It will start with the agents under the same supervised process configuration."

### 7b. Install and configure

**Windows:** use W4 of the loaded Windows reference for native directory,
install/build, supervision, listener, and browser/VPS operations.

**macOS/Linux:**

```text
cd <absolute-framework-root>/dashboard
npm ci
```

Ask the user:
> "Pick a username and password for the dashboard. This is what you'll use to log into localhost:3000."
> "Username? (default: admin)"
> "Password? (pick something you'll remember)"

If the user doesn't want to pick, use the auto-generated password from `dashboard.env` and show it clearly.

Read the generated values from the selected instance's `dashboard.env` with the
harness file tool. Never print `AUTH_SECRET` or the password into logs. If the
user chooses credentials, update `dashboard.env` with the Write/Edit tool while
preserving its restricted permissions.

Do not hand-write `dashboard/.env.local` when the supported generator can do it.
After dependencies are installed, run `cortextos ecosystem` in Phase 9; it
materializes the Git-ignored file from `dashboard.env` with restricted
permissions and keeps secrets out of PM2 configuration.

### 7c. Build and start

Do not launch `npm run dev &`; it creates an unsupervised process. Phase 9
starts the generated dashboard entry under PM2. After it is healthy, open it
with:

- macOS: `open http://localhost:3000`
- Linux: `xdg-open http://localhost:3000`
- Linux VPS: keep it bound to `127.0.0.1` and use the existing secure
  administration tunnel; never open a public dashboard port during onboarding.

Walk the user through the dashboard pages:

> "Quick tour of what's in the dashboard:"
> - **Agents** - real-time health status. Green = healthy, Red = stale or crashed.
> - **Tasks** - task queue across all agents. Create tasks, track completions.
> - **Approvals** - pending approval requests. Approve or reject to unblock agents.
> - **Analytics** - event timeline, cost tracking, task throughput.
> - **Experiments** - autoresearch cycles and results.
> - **Knowledge Base** - search your org's shared knowledge base.

Return to the absolute repository root with the native shell before continuing.

---

## Phase 8: Knowledge Base

> "cortextOS includes a semantic knowledge base - a shared RAG database your agents can read and write to. Agents upload files from their workspace - documents, images, audio, video - and any agent can query it with natural language. You can also search it from the web dashboard. Think of it as long-term shared memory across your entire team."

> "It requires a Google Gemini API key for embeddings. It's free to get one and the usage is minimal."

Ask: "Do you want to set up the knowledge base now? You'll need a Gemini API key from https://aistudio.google.com/apikey (free tier works fine)."

If yes:

1. Get the API key from the user
2. Use the Read/Edit tool to set `GEMINI_API_KEY=<key>` in the org's
   `secrets.env`, preserving all other values and the restricted file
   permissions established by `cortextos init`. Never put the key in a shell
   command or report.

3. On Windows, use W5 to install the optional KB environment only after this
   opt-in. On macOS/Linux, `cortextos install` creates the Python venv and
   installs KB dependencies when Python is available. Verify the venv and run a
   real ingest/query through the Node bus CLI.

4. Verify the core imports, ChromaDB directory, and one bounded query. If Python
   or the optional KB dependencies are unavailable, explain the remediation and
   let the user explicitly defer KB without failing the agent runtime install.

5. Offer to ingest initial docs:
   > "The knowledge base is ready. Want to seed it with any files now? Drop a file path or URL - docs, PDFs, images, anything. You can always add more later, and your agents will ingest their own findings as they work."

   For each file, use W5 of the loaded reference on Windows. On macOS/Linux:

   ```bash
   CTX_INSTANCE_ID='<instance-id>' CTX_FRAMEWORK_ROOT="$PWD" node dist/cli.js bus kb-ingest <path> --org <org-name> --scope shared
   ```

If no:
> "No problem. You can set it up later by adding a GEMINI_API_KEY to your org's secrets.env and running the knowledge-base setup/ingest flow from cortextOS. Your agents know how to use it once it's configured."

---

## Phase 9: Start the Daemon

Everything is configured. Now start the agents.

### 9a. Generate PM2 config and start

Use an instance-specific output filename. On a VPS, generate a loopback-only
dashboard with `--dashboard-host 127.0.0.1`; on a normal desktop, preserve the
documented local default unless the user asks for a different bind.

**Windows:** use W6 of the loaded Windows reference. It sets the instance,
state root, scoped PM2 home, ecosystem, and loopback dashboard in one native
PowerShell invocation.

**macOS/Linux:**

```bash
export CTX_INSTANCE_ID='<instance-id>'
export CTX_ROOT="$HOME/.cortextos/$CTX_INSTANCE_ID"
export PM2_HOME="${PM2_HOME:-$HOME/.pm2}"
node dist/cli.js ecosystem --instance "$CTX_INSTANCE_ID" --org '<org-name>' --output "ecosystem.$CTX_INSTANCE_ID.config.js"
pm2 start "ecosystem.$CTX_INSTANCE_ID.config.js"
pm2 save
```

Wait 5-10 seconds, then verify daemon, dashboard, poller, and runtime readiness.
Do not equate a PM2 `online` row with an agent that is ready to accept messages.

### 9b. Configure reboot survival by platform

**Windows:** use W7 of the loaded Windows reference for native, idempotent,
instance-scoped reboot persistence.

**macOS/Linux:** run `pm2 startup`, capture its recommended privileged command,
and defer that optional human step to Phase 10. Do not execute a generated sudo
command automatically.

### 9c. Verify and hand off to Telegram

```text
pm2 list
node dist/cli.js doctor --instance <instance-id>
node dist/cli.js status --instance <instance-id>
```

Confirm the dashboard responds only on its intended interface and the enabled
agent has crossed its runtime-readiness gate. On Windows use W8 for diagnostics,
logs, port health, and browser/VPS handoff. Then open the local dashboard and say:

> "Daemon and dashboard are running. Your Orchestrator is completing first boot and will message you on Telegram when onboarding is ready to continue."

---

## Phase 10: Done

Deliver verbatim:

> "You're all set. Here's what's running:"
> - **Orchestrator** (`<orch_name>`) - starting up on Telegram now
> - **Dashboard** - localhost:3000 (login credentials were saved in the selected instance's restricted dashboard.env)
> - **PM2 daemon** - keeps everything alive, auto-restarts on crash
>
> "Go to Telegram and wait for your Orchestrator to message you. It will walk you through its personality, goals, crons, and creating your Analyst agent."
>
> "If anything breaks, come back here and run `pm2 logs cortextos-daemon --lines 30`."

### Optional reboot survival (deferred — non-blocking)

On Windows, use W9 of the loaded Windows reference for the native completion
report and stop before the macOS/Linux block below.

On macOS/Linux, if `PM2_SUDO_CMD` from Phase 9b is non-empty, deliver this
verbatim AT THE END (not mid-flow):

> "**OPTIONAL — enable reboot survival**:
>
> Your daemon is running fine right now, but it won't auto-restart after a reboot of your machine. If you want reboot persistence (recommended for any real production use), run this command in another terminal:
>
> ```
> <PM2_SUDO_CMD>
> ```
>
> It may ask for your computer password. When you type it, nothing appears on screen — that's normal. Just type and press Enter. This is a one-time setup. cortextOS works fine without it; you can do this anytime."

If `PM2_SUDO_CMD` is empty (PM2 startup is already configured, or the system doesn't need it), skip this section silently.

**DO NOT block onboarding waiting for the user to run this command.** The whole point of BUG-021's fix is to keep the user moving forward. They can do reboot setup later when they're not in the middle of onboarding.

---

## Troubleshooting

**Agent not messaging on Telegram:**
1. Run `node dist/cli.js doctor --instance <instance>` and `node dist/cli.js status --instance <instance>`.
2. Inspect the selected instance's agent `stdout.log`, `activity.log`, and
   `fast-checker.log` with the harness Read tool.
3. Verify `.env` has non-empty BOT_TOKEN, CHAT_ID, and ALLOWED_USER without
   printing their values.
4. Check for one poller per token and a Telegram 409 conflict. Never start a
   second poller as a diagnostic.

**Daemon not starting:**
1. Check `pm2 logs <instance-scoped-daemon-name> --lines 30`.
2. Verify `dist/daemon.js` with the harness file tool.
3. Parse the selected instance's `config/enabled-agents.json` with a JSON-aware
   tool.

**Agent crashing immediately:**
1. Check stdout.log for errors
2. Verify the configured runtime's executable and authentication separately
3. Check `node dist/cli.js doctor --instance <instance>` for actionable failures

**Dashboard not loading:**
1. Check `dashboard/.env.local` has correct absolute paths (no `~`)
2. On macOS/Linux, use `lsof -i :3000`
3. Check dashboard npm logs

On Windows, use the W9 troubleshooting overlay instead of translating these
macOS/Linux shell diagnostics.
