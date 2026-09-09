// cortextOS Node.js - Core Type Definitions
// These types match the bash version's JSON formats exactly for backward compatibility

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export const PRIORITY_MAP: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export const VALID_PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low'];

// Message Bus Types

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  priority: Priority;
  timestamp: string; // ISO 8601
  text: string;
  reply_to: string | null;
  sig?: string; // Security (H10): HMAC-SHA256 signature — optional for backwards compat
}

// Task Types

/**
 * Every task status, as a RUNTIME value.
 *
 * `TaskStatus` is derived FROM this rather than declared beside it, so the list a
 * validator iterates and the type the compiler checks cannot drift apart. They
 * already had: `src/cli/bus.ts` carries a hand-written copy of these five, and a
 * sixth status added to the type would have left that copy silently short.
 */
export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Runtime check that a value is a real task status.
 *
 * Needed because data read off DISK is `unknown` no matter what the type says.
 * An audit line reading `{ from: null, to: 'in_progress' }` is a plain object, so
 * it survives a JSON shape check, and `null !== undefined` and `null !== 'in_progress'`,
 * so it survives a presence check and a difference check too — and is then counted
 * as a state change that never happened.
 */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export interface TaskOutput {
  /** Output kind. "file" links to a saved deliverable; other shapes reserved. */
  type: 'file';
  /** For type:"file", the path to the file relative to CTX_ROOT (forward-slash separated). */
  value: string;
  /** Optional human-readable label shown in dashboard task detail. */
  label?: string;
}

/** One note appended to a task after creation. Never mutates the description. */
export interface TaskAnnotation {
  /** ISO 8601, second precision (matches the audit log's format). */
  ts: string;
  /** Who wrote it. Attribution is the point: a correction with no author is a rumour. */
  agent: string;
  text: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  type: 'agent' | 'human';
  needs_approval: boolean;
  status: TaskStatus;
  assigned_to: string;
  created_by: string;
  org: string;
  priority: Priority;
  project: string;
  kpi_key: string | null;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  completed_at: string | null;
  due_date: string | null;
  archived: boolean;
  result?: string;
  /**
   * Dated, attributed notes appended after creation.
   *
   * Separate from `description` ON PURPOSE: the description is what the task was
   * ASSIGNED as, and rewriting it destroys the record of what was originally asked.
   * A correction is a new fact about the task, not a replacement for the old one —
   * so annotations accumulate and `description` stays byte-identical forever.
   */
  annotations?: TaskAnnotation[];
  /** Linked deliverables (files saved via `cortextos bus save-output`). */
  outputs?: TaskOutput[];
  /**
   * Dependency DAG edges (beads-inspired). Optional so existing task
   * files remain valid with these fields absent. `blocked_by` lists
   * task IDs that must reach `completed` before this task can
   * progress; `blocks` is the reverse view, maintained symmetrically
   * at create-time so queries in either direction are cheap.
   */
  blocks?: string[];
  blocked_by?: string[];
}

// Event Types

export type EventCategory =
  | 'action'
  | 'error'
  | 'metric'
  | 'milestone'
  | 'heartbeat'
  | 'message'
  | 'task'
  | 'approval'
  | 'agent_activity';

export type EventSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface Event {
  id: string;
  agent: string;
  org: string;
  timestamp: string; // ISO 8601
  category: EventCategory;
  event: string;
  severity: EventSeverity;
  metadata: Record<string, unknown>;
}

// Heartbeat Types

export interface Heartbeat {
  agent: string;
  org: string;
  display_name?: string; // user-configured name from IDENTITY.md (e.g. "Alpha", "Beta")
  status: string;
  current_task: string;
  mode: 'day' | 'night';
  last_heartbeat: string; // ISO 8601
  loop_interval: string;
  // Legacy field — sync.ts falls back to this if last_heartbeat absent
  timestamp?: string;
}

// Approval Types

export type ApprovalCategory =
  | 'external-comms'
  | 'financial'
  | 'deployment'
  | 'data-deletion'
  | 'other';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  title: string;
  requesting_agent: string;
  org: string;
  category: ApprovalCategory;
  status: ApprovalStatus;
  description: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

// Agent Config Types (config.json)

export interface EcosystemFeatureConfig {
  enabled?: boolean;
}

export interface EcosystemConfig {
  /** Daily git snapshots of agent workspace. Agent stages safe files, reviews diff, commits. */
  local_version_control?: EcosystemFeatureConfig;
  /** 24h cron to check canonical repo for framework updates. Requires upstream git remote. */
  upstream_sync?: EcosystemFeatureConfig;
  /** Weekly cron to browse community catalog and surface new skills/templates to user. */
  catalog_browse?: EcosystemFeatureConfig;
  /** On-demand workflow to publish custom skills/templates to the community catalog. */
  community_publish?: EcosystemFeatureConfig;
}

export interface AgentConfig {
  startup_delay?: number;
  max_session_seconds?: number;
  max_crashes_per_day?: number;
  /**
   * Sliding-window crash-loop detector. When N crashes occur within the window,
   * the agent auto-pauses (status: 'halted') instead of retrying. Absent = legacy
   * daily counter only.
   */
  crash_window?: { seconds: number; max_crashes?: number };
  model?: string;
  /** Codex app-server reasoning effort applied to resumed threads and every turn. */
  reasoning_effort?: string;
  /**
   * Whether to launch Claude Code with `--dangerously-skip-permissions`.
   * Defaults to true (back-compat: agents run unattended). Set to false to keep
   * Claude Code's permission system engaged so the PermissionRequest hook
   * (hook-permission-telegram) gates tool use instead of everything auto-running.
   * Only applies to the claude-code runtime (Hermes never passes the flag).
   */
  dangerously_skip_permissions?: boolean;
  working_directory?: string;
  enabled?: boolean;
  crons?: CronEntry[];
  timezone?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  communication_style?: string;
  approval_rules?: {
    always_ask: string[];
    never_ask: string[];
  };
  ecosystem?: EcosystemConfig;
  /** Context window % at which to warn agent + user. Default: 70. Absent = observe-only. */
  ctx_warning_threshold?: number;
  /** Context window % at which to inject handoff prompt and hard-restart. Default: 80. */
  ctx_handoff_threshold?: number;
  /**
   * Fallback context window cap (tokens) for codex-app-server agents when the
   * server's `thread/tokenUsage/updated` event reports `modelContextWindow=null`.
   * Defaults to 256000 when unset. Only applied to the codex-app-server runtime.
   */
  codex_context_cap?: number;
  /**
   * Fallback context window cap (tokens) for opencode agents when the OpenCode
   * model cache does not expose a context limit. Only applies to runtime:
   * 'opencode'.
   */
  opencode_context_cap?: number;
  /**
   * Agent runtime. Defaults to 'claude-code' when absent.
   * 'hermes' selects the HermesPTY spawn path (Python persistent REPL,
   * NousResearch/hermes-agent) with Hermes-specific bootstrap, session
   * continuity, and exit handling.
   * 'opencode' selects the OpencodePTY spawn path, a native PTY terminal
   * runtime for opencode.ai's OpenCode CLI.
   */
  runtime?: 'claude-code' | 'hermes' | 'codex-app-server' | 'opencode';
  /**
   * Isolated Hermes profile name. Required by HermesPTY for standing agents;
   * the shared `default` profile is deliberately rejected.
   */
  hermes_profile?: string;
  /** Explicit Hermes inference provider override for each launch. */
  hermes_provider?: string;
  /** Explicit Hermes reasoning effort override for each launch. */
  hermes_reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  /**
   * Which scheduler owns this Hermes agent's crons. Omitted legacy configs are
   * treated as `native` so they are never double-scheduled. New Hermes
   * templates set `cortextos` explicitly; the manager then requires a clean
   * Hermes-native jobs file before it starts the external scheduler.
   */
  hermes_cron_ownership?: 'native' | 'cortextos';
  /**
   * Optional OpenCode agent name to pass as `opencode --agent <name>`.
   * Only applies to runtime: 'opencode'.
   */
  opencode_agent?: string;
  /**
   * Whether this agent runs a Telegram poller. Defaults to true when absent
   * (preserves existing behaviour). Set to false on specialist agents that
   * should not own a Telegram bot — only the designated orchestrator agent
   * should poll. Requires BOT_TOKEN + CHAT_ID to already be unset or the
   * poller will be skipped regardless.
   */
  telegram_polling?: boolean;
  /**
   * Whether the configured org orchestrator emits routine boot, restart,
   * handoff, recovery, and back-online Telegram. Defaults to enabled when
   * absent, but never grants authority to a non-orchestrator. Set to false to
   * keep routine churn silent while preserving real crash and halt alerts.
   */
  telegram_lifecycle_notifications?: boolean;
}

export interface CronEntry {
  name: string;
  /** For recurring crons: how often to fire (e.g. "4h", "1d"). */
  interval?: string;
  /** For time-anchored crons: a cron expression (e.g. "0 8 * * *"). Takes precedence over interval. */
  cron?: string;
  /** For one-shot crons: ISO 8601 datetime when the cron should fire. */
  fire_at?: string;
  prompt: string;
  /** "recurring" (default) restores on every session start.
   *  "once" restores only if fire_at is still in the future; deleted after firing. */
  type?: 'recurring' | 'once' | 'disabled';
}

// ---------------------------------------------------------------------------
// External Persistent Cron System — Subtask 1.1
// ---------------------------------------------------------------------------
//
// CronDefinition is the canonical record stored in per-agent crons.json files:
//   .cortextOS/state/agents/{agent_name}/crons.json
//
// The file is an array of CronDefinition objects.  The daemon reads it, schedules
// each enabled cron, and injects the prompt into the agent's PTY on schedule.
//
// Operators may edit crons.json by hand (it is intentionally human-readable).
// Keep all field names lowercase-snake-case and all times as ISO 8601 UTC.
//
// Example records
// ---------------
// WARNING: these are crons.json (CronDefinition) examples, not config.json.
// The `enabled` field shown below belongs to CronDefinition ONLY — CronEntry
// (config.json, above) has no `enabled` field. Setting `enabled: false` on a
// config.json cron entry does nothing; it migrates as an enabled live cron
// regardless. To disable a config.json cron, set `type: "disabled"` instead.
//
// Migration REPLACES crons.json, it does not merge: runMigrationCore() (see
// src/daemon/cron-migration.ts) writes the full crons.json envelope from
// config.json's crons array alone. A live cron with no config.json
// counterpart is not preserved — it is deleted on the next migration run.
//
// Heartbeat — every 6 hours (interval shorthand):
// {
//   "name": "heartbeat",
//   "schedule": "6h",
//   "prompt": "Read HEARTBEAT.md and execute the heartbeat workflow.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Periodic health check and status update."
// }
//
// Daily morning briefing — fixed local time via cron expression:
// {
//   "name": "morning-briefing",
//   "schedule": "0 13 * * *",
//   "prompt": "Prepare and send the morning briefing to James.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Daily 09:00 ET briefing (UTC offset applied in schedule).",
//   "last_fired_at": "2026-04-28T13:00:01.042Z",
//   "fire_count": 14
// }
//
// Weekly report — cron expression with day-of-week restriction:
// {
//   "name": "weekly-report",
//   "schedule": "0 16 * * 1",
//   "prompt": "Compile and send the weekly performance report.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Every Monday at 12:00 ET (16:00 UTC).",
//   "fire_count": 3
// }

/**
 * A single persistent cron definition stored in an agent's crons.json.
 *
 * Stored at: `.cortextOS/state/agents/{agent_name}/crons.json`
 *
 * The `schedule` field accepts two formats:
 *   - Interval shorthand: `"6h"`, `"30m"`, `"1d"`, `"2w"`
 *     Parsed by `parseDurationMs()` from `src/bus/cron-state.ts`.
 *   - Standard 5-field cron expression: `"0 8 * * *"`, `"0 0,6,12,18 * * *"` (every 6h)
 *     Evaluated by the daemon scheduler (Subtask 1.3).
 *
 * The daemon fires the cron by injecting `[CRON: {name}] {prompt}` into
 * the agent's PTY session.
 */
export interface CronDefinition {
  // ------------------------------------------------------------------
  // Required fields — must be present for the daemon to schedule this cron.
  // ------------------------------------------------------------------

  /**
   * Unique identifier for this cron within the agent.
   * Used as the key for lookups, updates, and deletions.
   * Must be unique per agent; slugs like "heartbeat" or "morning-briefing" are recommended.
   *
   * @example "heartbeat"
   * @example "morning-briefing"
   */
  name: string;

  /**
   * The prompt text injected into the agent PTY when the cron fires.
   * The daemon prepends `[CRON: {name}] ` automatically for traceability.
   *
   * @example "Read HEARTBEAT.md and execute the heartbeat workflow."
   */
  prompt: string;

  /**
   * When and how often this cron fires.
   *
   * Accepted formats:
   *   - Interval shorthand: `"6h"`, `"30m"`, `"1d"`, `"2w"`
   *     The cron fires every N units after its previous fire (or after daemon start
   *     if it has never fired).
   *   - 5-field cron expression: `"0 8 * * *"`, `"0 0,6,12,18 * * *"`, `"0 16 * * 1"`
   *     Evaluated against the daemon's wall clock (daemon timezone = server timezone).
   *
   * @example "6h"         — every six hours
   * @example "0 13 * * *" — daily at 13:00 UTC
   * @example "0 16 * * 1" — every Monday at 16:00 UTC
   */
  schedule: string;

  /**
   * Whether the daemon should fire this cron.
   * Set to `false` to pause a cron without deleting it.
   *
   * @default true
   */
  enabled: boolean;

  /**
   * ISO 8601 UTC timestamp of when this cron definition was created.
   * Set automatically by `cortextos bus add-cron`; operators should not modify this.
   *
   * @example "2026-04-01T00:00:00.000Z"
   */
  created_at: string;

  // ------------------------------------------------------------------
  // Optional fields — populated at runtime or by operators.
  // ------------------------------------------------------------------

  /**
   * ISO 8601 UTC timestamp of the most recent successful fire.
   * Updated by the daemon scheduler (Subtask 1.3) after each fire.
   * Absent when the cron has never fired.
   *
   * @example "2026-04-28T13:00:01.042Z"
   */
  last_fired_at?: string;

  /**
   * ISO 8601 UTC timestamp set by the scheduler IMMEDIATELY before it awaits
   * the onFire dispatch — i.e. before the agent has acked. On daemon crash
   * mid-fire, this lets `loadCrons` recompute `referenceMs` from the attempt
   * timestamp instead of the stale `last_fired_at`, preventing a double-fire
   * via the catch-up gate. Tradeoff: a fire whose dispatch genuinely failed
   * pre-crash will be skipped one window — preferable to guaranteed re-fire.
   */
  last_fire_attempted_at?: string;

  /**
   * Total number of times this cron has successfully fired.
   * Incremented by the daemon on each successful PTY injection.
   * Absent (or 0) when the cron has never fired.
   */
  fire_count?: number;

  /**
   * ISO 8601 UTC timestamp for one-shot crons — when the cron should fire once
   * and then be deleted. Mutually exclusive with recurring `schedule` semantics:
   * if `fire_at` is set, the daemon treats this as a one-shot regardless of
   * `schedule`. Used by `cron-health.ts` to flag never-fired one-shots that
   * are still inside their grace window as healthy rather than stale.
   *
   * @example "2026-05-15T14:00:00.000Z"
   */
  fire_at?: string;

  /**
   * Human-readable description of what this cron does.
   * Optional — for operator documentation and dashboard display.
   *
   * @example "Periodic health check and status update."
   */
  description?: string;

  /**
   * Arbitrary key-value pairs for agent-specific context.
   * Not interpreted by the daemon; surfaced in dashboard + execution logs.
   *
   * @example { "priority": "high", "source": "/loop" }
   */
  metadata?: Record<string, unknown>;

  /**
   * When true, the Test Fire button in the dashboard is disabled and the
   * IPC fire-cron handler refuses manual-trigger requests.
   *
   * Use this for crons that must only run on their schedule (e.g. crons
   * that do destructive operations or have strict rate-limit contracts).
   *
   * @default false (manual fire is allowed by default — opt-out model)
   */
  manualFireDisabled?: boolean;
}

// ---------------------------------------------------------------------------
// Cron Execution Log — Subtask 1.5
// ---------------------------------------------------------------------------

/**
 * A single entry in the per-agent cron execution log
 * (`$CTX_ROOT/.cortextOS/state/agents/{agent}/cron-execution.log`).
 *
 * The file is JSONL (one JSON object per line, newline-separated).
 * It is append-only; log rotation prunes to the last 1 000 lines.
 *
 * Status semantics:
 *   "fired"   — the fire attempt succeeded on this attempt.
 *   "retried" — this attempt failed but more retries remain (see `error`).
 *   "failed"  — final failure after exhausting all retries (see `error`).
 */
export interface CronExecutionLogEntry {
  /** ISO 8601 UTC timestamp of the fire attempt. */
  ts: string;
  /**
   * ISO 8601 UTC instant this fire was SCHEDULED for, when the scheduler knows
   * it. `ts - due_at` is the lateness, and it is the only way to tell a fire
   * that happened on time from one that happened fifteen minutes late.
   *
   * ⛔ WHY IT WAS ADDED (2026-09-09). A host sleep from 15:25:02Z left the
   * daemon suspended; it ran only inside ~2s macOS DarkWake windows ~16 min
   * apart, and fires landed up to 15m29s late against a 30s tick. Every one of
   * them was logged `{"status":"fired"}` with a `ts` and nothing else, so a late
   * fire and an on-time fire were written in identical words. The lateness was
   * recoverable only by matching timestamps against `pmset`, a log this system
   * does not own and never reads.
   *
   * OPTIONAL, and it stays optional: every line already on disk lacks it, and a
   * reader that requires it would refuse the entire existing history.
   */
  due_at?: string;
  /** Cron name (matches CronDefinition.name). */
  cron: string;
  /** Outcome of this attempt. */
  status: 'fired' | 'retried' | 'failed';
  /** Attempt index (1-based). */
  attempt: number;
  /** Wall-clock duration of the fire attempt in milliseconds. */
  duration_ms: number;
  /** Error message if status is "retried" or "failed"; null otherwise. */
  error: string | null;
}

export interface OrgContext {
  name?: string;
  description?: string;
  industry?: string;
  icp?: string;
  value_prop?: string;
  timezone?: string;
  orchestrator?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  default_approval_categories?: string[];
  communication_style?: string;
  dashboard_url?: string;
  /** When true, agents are instructed at startup that every task submitted
   *  for review must have at least one file deliverable attached via
   *  save-output. The instruction is injected into the boot prompt
   *  dynamically — no agent markdown files are modified. */
  require_deliverables?: boolean;
}

// Telegram Types

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReaction;
}

/**
 * One item in a Telegram message's reaction list. Telegram supports
 * `type: 'emoji'` (standard emoji, the only shape we handle today) and
 * `type: 'custom_emoji'` (premium custom emoji, carrying a `custom_emoji_id`
 * instead of an `emoji` character). Shaped as a tagged union so call sites
 * can narrow safely.
 */
export type TelegramReactionType =
  | { type: 'emoji'; emoji: string }
  | { type: 'custom_emoji'; custom_emoji_id: string };

/**
 * A `message_reaction` update fires when a user adds or removes an
 * emoji reaction on a chat message the bot can see. `old_reaction` and
 * `new_reaction` are the reaction state before/after — empty means "no
 * reaction", so the diff is (new) minus (old). Requires
 * `allowed_updates: ['message_reaction']` in the getUpdates call.
 */
export interface TelegramMessageReaction {
  chat: TelegramChat;
  user?: TelegramUser;
  message_id: number;
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
}

export interface TelegramVoice {
  file_id: string;
  duration: number;
}

export interface TelegramAudio {
  file_id: string;
  duration: number;
  file_name?: string;
}

export interface TelegramVideo {
  file_id: string;
  duration: number;
  file_name?: string;
}

export interface TelegramVideoNote {
  file_id: string;
  duration: number;
}

// Task Management Report Types

export interface StaleTaskReport {
  stale_in_progress: Task[];
  stale_pending: Task[];
  /**
   * Tasks sitting in `blocked` longer than the threshold.
   *
   * Added 2026-08-20. `blocked` is a LEGITIMATE state, so nothing alarms on it
   * and nobody looks — a task could sit blocked indefinitely while this report
   * returned four empty arrays, i.e. "all clear". Four empty arrays are
   * indistinguishable from a checker with no bucket to fill.
   */
  stale_blocked: Task[];
  stale_human: Task[];
  overdue: Task[];
  /**
   * Both staleness clocks for EVERY `in_progress` task, stale or not.
   *
   * `clock_age_seconds` is `now - updated_at` — the field the check has always
   * read. `true_idle_seconds` is `now - <newest audit transition>`, falling back
   * to `created_at`. They diverge exactly when a write moved `updated_at`
   * without changing anything, which is how a genuinely idle task was being
   * cleared: measured 2026-09-08, the shipped check cleared 5 of 10 in_progress
   * tasks and all 5 were idle 4.2h-20.9h.
   *
   * Emitted for every row rather than only stale ones ON PURPOSE: a consumer
   * has to be able to see the two clocks disagree on a row that is being
   * CLEARED, since a cleared row is the case that produced no output at all.
   */
  idle_ages: TaskIdleAge[];
  /**
   * Every non-completed task whose OWN timestamps are unusable, whatever bucket it lands in.
   *
   * ⛔ THIS ARRAY EXISTS BECAUSE THE FIRST VERSION OF THE DIAGNOSTIC WAS PUT IN THE WRONG HOME.
   * `clock_future` was added to `idle_ages`, and `idle_ages` is an `in_progress`-ONLY array — so
   * the flag sat in the one bucket that does NOT need it (`in_progress` alarms on
   * `max(clock, idle)`, and the idle clock still decides when the clock is unusable) and was
   * ABSENT from the three that do: `blocked` reads `updated_at` alone, `pending` and `human` read
   * `created_at` alone, and a broken value there cleared the row with nothing to say so.
   * ⭐ A BROKEN CLOCK IS A FACT ABOUT THE TASK, NOT ABOUT THE BUCKET IT HAPPENS TO SORT INTO.
   *
   * `overdue` is deliberately NOT covered: it reads `due_date`, and a due date in the future is
   * exactly what "not overdue yet" means. That is semantics, not a broken clock.
   */
  clock_anomalies: TaskClockAnomaly[];
}

/** How one timestamp read. See TaskClockAnomaly. */
export type ClockVerdict = 'ok' | 'skew' | 'future' | 'malformed';

/**
 * How far into the future a timestamp may sit before it stops being clock skew and starts being
 * broken data.
 *
 * ⚠ THE TOLERANCE IS THE WHOLE REASON THIS IS SAFE TO SHIP. Treating "future" as "maximally stale"
 * with NO tolerance would turn a few seconds of NTP or multi-process skew — which this fleet
 * produces routinely, since several writers stamp these files — into a task reading as ~45,000
 * hours idle, and every one of those would alarm. An alarm generator is not an improvement on a
 * false clear; it is the same failure pointing the other way, and it is the failure that teaches an
 * operator to stop reading alarms.
 *
 * 300s is generous against real skew on one machine and negligible against the thresholds it feeds
 * (2h in_progress, 4h blocked, 24h pending/human).
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 300;

/** One task whose timestamps could not be trusted, and what was wrong with each. */
export interface TaskClockAnomaly {
  task_id: string;
  /** The task's status, so a reader can see WHICH bucket the broken clock was feeding. */
  status: TaskStatus;
  /** Verdict on `updated_at`. Drives `stale_in_progress` and `stale_blocked`. */
  updated_at_verdict: ClockVerdict;
  /** Verdict on `created_at`. Drives `stale_pending` and `stale_human`. */
  created_at_verdict: ClockVerdict;
  /**
   * Seconds each timestamp sits in the FUTURE, or 0. Reported so the SIZE is visible: two seconds
   * of skew and three hours of a wrong clock are different problems wearing the same verdict when
   * only the verdict is printed.
   */
  updated_at_future_by_seconds: number;
  created_at_future_by_seconds: number;
}

/**
 * The two staleness clocks for one `in_progress` task, plus what the read had to
 * discard to produce them. See StaleTaskReport.idle_ages.
 *
 * ⛔ NEITHER AGE IS EVER `null`, `NaN`, OR NEGATIVE. Those are the three values a
 * consumer reads as "no problem here" while meaning "this data is broken":
 * `NaN > threshold` is false, `null` renders as an absent age, and a negative
 * age reads as activity in the future. Malformed input is reported as MAXIMALLY
 * STALE with the matching flag set, never as fresh.
 */
export interface TaskIdleAge {
  task_id: string;
  /**
   * now - updated_at, in seconds. Moves on ANY write, including a no-op.
   * When `clock_malformed` is true this is the maximally-stale sentinel
   * (the age of a task stamped at the UNIX epoch), not a measured age.
   */
  clock_age_seconds: number;
  /** now - newest valid PAST audit transition (else created_at), in seconds. Never negative. */
  true_idle_seconds: number;
  /** `updated_at` did not parse. `clock_age_seconds` is the sentinel, and the row alarms. */
  clock_malformed: boolean;
  /**
   * `updated_at` is in the FUTURE, so `clock_age_seconds` was negative and was clamped to 0.
   *
   * ⚠ READ THIS BEFORE TRUSTING A CLEARED ROW THAT CARRIES IT. Clamping honours the
   * no-negative-age contract above, and it points the REASSURING way: a clamped clock
   * reads as "just written". For `in_progress` that is harmless, because the idle clock
   * is the other half of `max()` and still decides. For `blocked`, `pending` and `human`
   * there IS no second clock, so a future `updated_at` clears those rows — exactly as a
   * negative age already did before the clamp. The clamp changes the number, not that
   * outcome. Recorded here rather than fixed silently.
   */
  clock_future: boolean;
  /** `true_idle_seconds` was negative and was clamped to 0 — a future-dated `created_at`. */
  idle_clamped: boolean;
  /**
   * Audit lines that were valid JSON but not an entry object — the literal
   * `null`, a bare number, a string, an array. Skipped AND counted: a filter
   * that cannot say how much it excluded is indistinguishable from one that
   * excluded nothing. Non-zero here means this task's history is partly
   * unreadable, so a low idle age is weak evidence rather than reassurance.
   */
  audit_lines_malformed: number;
  /** Audit lines that were not valid JSON at all (a write that crashed mid-line). */
  audit_lines_unparseable: number;
  /** Transitions whose `ts` did not parse: they cannot date an event, so they were ignored. */
  audit_transitions_unparseable_ts: number;
  /** Transitions dated in the FUTURE: ignored, because they cannot establish present activity. */
  audit_transitions_future: number;
  /**
   * Audit lines carrying BOTH ends where at least one is NOT a real `TaskStatus` —
   * `null`, a number, an unknown string. Rejected and counted.
   *
   * ⛔ THE SHAPE CHECK ON THE LINE DOES NOT COVER THIS, and that is why it needed its own
   * field. `{ from: null, to: 'in_progress' }` is a plain object, so it passes the
   * JSON-shape filter; `null !== undefined`, so it passes the presence check; and
   * `null !== 'in_progress'`, so it passes the difference check. A line can be malformed
   * DATA inside a well-formed OBJECT, and every guard before this one asked about the
   * container.
   */
  audit_transitions_invalid_endpoint: number;
  /**
   * Audit lines carrying `from === to` — both ends written, nothing changed.
   * `updateTask` emits these unconditionally, so `update-task <id> in_progress`
   * on an already-`in_progress` task produces one. They are NOT transitions.
   */
  audit_transitions_no_op: number;
}

export interface ArchiveReport {
  archived: number;
  skipped: number;
  dry_run: boolean;
}

// Environment / Context Types

export interface CtxEnv {
  instanceId: string;
  ctxRoot: string;
  frameworkRoot: string;
  agentName: string;
  agentDir: string;
  org: string;
  projectRoot: string;
  timezone?: string;
  orchestrator?: string;
}

// Bus Path Types

export interface BusPaths {
  ctxRoot: string;
  inbox: string;
  inflight: string;
  processed: string;
  logDir: string;
  stateDir: string;
  taskDir: string;
  approvalDir: string;
  analyticsDir: string;
  /**
   * Per-org deliverables root: {ctxRoot}/orgs/{org}/deliverables/.
   * Files saved here are servable by the dashboard's /api/media route because
   * they live under CTX_ROOT.
   */
  deliverablesDir: string;
}

// IPC Types

export type IPCCommandType =
  | 'status'
  | 'start-agent'
  | 'stop-agent'
  | 'restart-agent'
  | 'wake'
  | 'list-agents'
  | 'spawn-worker'
  | 'terminate-worker'
  | 'list-workers'
  | 'inject-worker'
  | 'reload-crons'
  | 'fire-cron'
  | 'inject-agent'
  | 'list-all-crons'
  | 'list-cron-executions'
  | 'add-cron'
  | 'update-cron'
  | 'remove-cron'
  | 'fleet-health'
  | 'daemon-info';

// ---------------------------------------------------------------------------
// Execution log pagination response — Subtask 4.3
// ---------------------------------------------------------------------------

/**
 * Paginated response for list-cron-executions IPC command.
 */
export interface CronExecutionLogPage {
  entries: CronExecutionLogEntry[];
  /** Total matching entries (after cronName + statusFilter applied). */
  total: number;
  /** True when there are more entries older than this page. */
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// list-all-crons response shape — Subtask 4.1
// ---------------------------------------------------------------------------

/**
 * One row returned by the `list-all-crons` IPC command.
 * Combines the cron definition with runtime state (last fire, next fire, status).
 */
export interface CronSummaryRow {
  /** Agent that owns this cron. */
  agent: string;
  /** Org the agent belongs to (from enabled-agents.json). */
  org: string;
  /** Full cron definition as stored in crons.json. */
  cron: CronDefinition;
  /**
   * ISO 8601 timestamp of the most recent fire attempt.
   * Null when the cron has never fired (no execution log entry).
   */
  lastFire: string | null;
  /**
   * Outcome of the most recent execution log entry.
   * Null when the cron has never fired.
   */
  lastStatus: 'fired' | 'retried' | 'failed' | null;
  /**
   * ISO 8601 timestamp of the next scheduled fire.
   * Computed from the cron's schedule + last_fired_at (or now).
   */
  nextFire: string;
}

// ---------------------------------------------------------------------------
// Fleet Health — Subtask 4.4
// ---------------------------------------------------------------------------

export type CronHealthState = 'healthy' | 'warning' | 'failure' | 'never-fired';

/** Health record for a single cron, returned by the fleet-health IPC command. */
export interface CronHealthRow {
  agent: string;
  org: string;
  cronName: string;
  state: CronHealthState;
  reason: string;
  lastFire: number | null;
  expectedIntervalMs: number;
  gapMs: number | null;
  successRate24h: number;
  firesLast24h: number;
  nextFire: string;
}

/** Per-agent breakdown in the fleet-health summary. */
export interface AgentHealthSummary {
  agent: string;
  org: string;
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

/** Full response returned by the fleet-health IPC command. */
export interface FleetHealthResponse {
  rows: CronHealthRow[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    failure: number;
    neverFired: number;
    agents: Record<string, AgentHealthSummary>;
  };
}

export interface IPCRequest {
  type: IPCCommandType;
  agent?: string;
  data?: Record<string, unknown>;
  /**
   * BUG-015: human-readable identifier of the caller (e.g. 'cortextos enable',
   * 'cortextos bus soft-restart-all'). Logged by the daemon on every incoming
   * IPC request so we can trace which CLI command triggered which daemon action.
   * Optional for backwards compatibility — older clients fall back to 'unknown'.
   */
  source?: string;
  /**
   * disable-resurrection fix: for the `stop-agent` command, whether this stop was
   * directly initiated by the user (`cortextos stop` / `cortextos disable`) — in
   * which case a queued pendingRestart is DROPPED (stop wins) — vs an internal
   * stop that is part of a larger restart (`cortextos restart`'s stop-half),
   * which must set this to false so its own follow-up start-agent is honored via
   * the pendingRestart path. The handler defaults to true when omitted so plain
   * stop/disable keep "stop wins".
   */
  userInitiated?: boolean;
}

// Worker Types

export type WorkerStatusValue = 'starting' | 'running' | 'completed' | 'failed';

export interface WorkerStatus {
  name: string;
  status: WorkerStatusValue;
  pid?: number;
  dir: string;
  parent?: string;
  spawnedAt: string;
  exitCode?: number;
}

export interface IPCResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * Structured error code for failed responses. Lets operators distinguish
   * "agent does not exist" (NOT_FOUND) from "request collapsed against an
   * in-flight identical op" (DEDUPED). See issue #346.
   */
  code?: 'NOT_FOUND' | 'DEDUPED' | 'INVALID_INPUT' | 'NOT_RUNNING';
}

// Agent Discovery Types

export interface AgentInfo {
  name: string;
  org: string;
  display_name?: string;  // user-configured name from IDENTITY.md (e.g. "Alpha", "Beta")
  role: string;
  enabled: boolean;
  running: boolean;
  last_heartbeat: string | null;
  current_task: string | null;
  mode: string | null;
}

// Agent Status (returned by daemon)

export interface AgentStatus {
  name: string;
  status: 'running' | 'stopped' | 'crashed' | 'starting' | 'halted';
  pid?: number;
  uptime?: number; // seconds
  lastHeartbeat?: string;
  sessionStart?: string;
  crashCount?: number;
  /** Executing model when the runtime exposes it; otherwise the configured model. */
  model?: string;
  /** Requested model when it differs conceptually from the runtime observation. */
  configuredModel?: string;
  /** False when a runtime supports actual-model reporting but has not produced a reading yet. */
  modelObserved?: boolean;
  /** True only when both configured and observed models are known and disagree. */
  modelMismatch?: boolean;
  awaitingConfirmation?: boolean; // first-run observability fix: PTY parked on an
  // interactive first-run prompt past the auto-accept backstop (wedged, not bootstrapped)
  dormant?: boolean; // silent-dormancy fix: enabled agent whose heartbeat is stale
  // relative to its own liveness baseline (uptime, or daemon uptime if absent-from-map)
  dormancyReason?: string; // human explanation of the dormancy verdict
}
