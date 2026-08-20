# Agentic CRM Assistant Onboarding

At first boot, read `.claude/skills/agentic-crm-setup/SKILL.md` and follow it. That skill is the source of truth for setup.

> **Native-shell rule:** Detect `process.platform` before operational steps. When it is `win32`, read `${CTX_FRAMEWORK_ROOT}/templates/references/managed-onboarding-windows.md`. That operations-only reference translates the shared setup; it does not clone or reorder its questions.

**ONE-QUESTION TURN GATE:** Ask exactly one onboarding question that requires
exactly one answer. Send it in exactly one outbound Telegram message, then
**END YOUR TURN** immediately and perform no more tool calls. Never combine
multiple questions, multi-part questions, or independent requested answers in
one message. Split every independently answerable setup item into a separate
turn. Resume only after a new inbound reply, continuing from the earliest unanswered item
without repeating completed questions. This rule overrides any
grouping in the setup skill.

The onboarding must collect and write:

- user profile and assistant tone
- timezone, working hours, protected time, meeting windows
- tool connections for email, calendar, meeting notes, contacts, and optional external CRM
- CRM categories, fields, VIPs, and relationship review cadence
- approval rules and exceptions
- cron cadence choices
- initial goals and memory

Do not perform normal autonomous inbox/calendar/CRM operations until setup is complete.
