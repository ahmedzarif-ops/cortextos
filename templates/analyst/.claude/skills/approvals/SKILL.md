---
name: approvals
description: "For external, irreversible, or high-stakes actions, prepare a decision package. Specialists in orchestrated orgs route it to the orchestrator, who handles owner-gated approval; standalone agents and orchestrators use the approval workflow. Wait for the required decision before acting."
triggers: ["need approval", "create approval", "request approval", "approval needed", "needs sign-off", "needs permission", "before deploying", "before sending email", "before deleting", "before posting", "external action", "irreversible action", "financial commitment", "purchase", "deploy to production", "merge to main", "send to real person", "publish", "approval workflow", "pending approval", "waiting for approval", "check approvals", "list approvals"]
---

# Approvals

Before an external, irreversible, or high-stakes action, stop and prepare a decision package. In an orchestrated org, a specialist sends the package to the configured orchestrator. The orchestrator makes routine internal decisions and obtains the owner's decision for owner-gated actions. A specialist must not call `create-approval` if that call can notify the owner directly. Direct replies to an owner who contacts the specialist remain allowed; the specialist then informs the orchestrator. The closed exceptions are in the org's canonical ONE VOICE rule (the configured orchestrator's `USER.md`; chief `USER.md` in this fleet).

The approval workflow below is for the orchestrator or a standalone agent. Execute the proposed action only after the required decision arrives.

---

## When to Use

| Action type | Requires approval? |
|-------------|-------------------|
| Sending emails to real people | YES |
| Deploying code to production | YES |
| Posting on social media | YES |
| Making financial commitments | YES |
| Deleting data (files, DB rows, records) | YES |
| Merging to main branch | YES |
| Any action visible to external parties | YES |
| Internal work (writing files, creating tasks, research) | NO |

---

## Full Workflow

### 0. Specialist in an orchestrated org

```bash
cortextos bus send-message "$CTX_ORCHESTRATOR_AGENT" high "Decision package: <action, target, draft, reason, owner gate, task id>"
```

Stop here as a specialist. Wait for the orchestrator's answer. Keep the task pending or blocked with the dependency recorded. For customer contact, production deploys, publication, spend, pricing, deletion, and other owner-gated actions, the orchestrator obtains the owner's approval before execution. Do not turn a routine internal decision into an owner notification.

### 1. Create the approval

```bash
APPR_ID=$(cortextos bus create-approval \
  "<what you want to do>" \
  "<category>" \
  "<context: draft content, target, why needed>")
echo "APPR_ID=$APPR_ID"
```

Categories: `external-comms` | `financial` | `deployment` | `data-deletion` | `other`

### 2. Block your task on the approval

```bash
cortextos bus update-task "$TASK_ID" blocked
```

### 3. Owner notification

Only the orchestrator or a standalone agent runs steps 1–2. Use the approval dashboard and the org's communication rules for any owner notification; a specialist sends no additional owner message from this workflow.

### 4. Wait for inbox notification

When the user decides, you receive an inbox message:
```
approval_id: appr_xxx
decision: approved | rejected
note: <user's note>
```

### 5. Act on the decision

**Approved:**
```bash
# Unblock task
cortextos bus update-task "$TASK_ID" in_progress
# Execute the action
# Complete the task
cortextos bus complete-task "$TASK_ID" --result "<what was done>"
```

**Rejected:**
```bash
cortextos bus complete-task "$TASK_ID" --result "Cancelled — approval rejected: <note>"
```

---

## Re-pinging

After four hours in day mode, a specialist may send one follow-up to the orchestrator. The orchestrator decides whether an owner reminder is warranted.

```bash
cortextos bus send-message "$CTX_ORCHESTRATOR_AGENT" normal \
  "One follow-up: approval for '<title>' remains pending"
```

---

## Listing Pending Approvals

```bash
cortextos bus list-approvals --status pending
```

---

## Critical Rules

1. **Create approval BEFORE starting the action** — never take the action first and ask forgiveness
2. **Always block your task** pointing to the approval ID — so work isn't lost while waiting
3. **Never assume approval** — if you don't have an inbox confirmation, you don't have approval
4. **One re-ping max** — after 4h, ping once and wait
