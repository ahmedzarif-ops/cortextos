import { NextRequest } from 'next/server';
import { createConnection } from 'net';
import { homedir } from 'os';
import fs from 'fs';
import path from 'path';
import { getCTXRoot, getAllAgents, getOrgs } from '@/lib/config';
import {
  ConfinementError,
  confined,
  extractPaths,
  lastLines,
  ptyScreen,
  readTail,
  seatEvents,
  validName,
} from '@/lib/city-inspect';

export const dynamic = 'force-dynamic';

/**
 * GET /api/city-inspect?type=task|worker|seat&id=... — what one thing in the
 * Agent City is doing, read from its own records at request time.
 *
 * Phase 4 companion to /api/city-state. Same laws (city/SIGNALS.md):
 *   - read the source files, never the SQLite cache;
 *   - anything unmeasurable is null plus a `note` saying why, never a default;
 *   - every block names its `source`, and the document carries `read_at`.
 *
 * Safety: auth is the middleware's (every /api/* without a verified session or
 * Bearer JWT gets 401 before this runs). `type` is an enum, `id` and `org` must
 * pass NAME_RE, the org must be an installed one, and every file is opened via
 * `confined()`, which refuses any path that resolves outside its root. It
 * reads only; it never spawns a process.
 */

const INSTANCE = process.env.CTX_INSTANCE_ID || 'default';

function bad(status: number, error: string) {
  return Response.json({ error }, { status });
}

function daemonRequest<T>(type: string, timeoutMs = 2000): Promise<T[] | null> {
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\cortextos-${INSTANCE}`
      : path.join(homedir(), '.cortextos', INSTANCE, 'daemon.sock');
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: T[] | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let socket: ReturnType<typeof createConnection>;
    try {
      socket = createConnection(socketPath, () => socket.write(JSON.stringify({ type })));
    } catch {
      return done(null);
    }
    let buf = '';
    socket.on('data', (c: Buffer) => {
      buf += c.toString();
    });
    socket.on('end', () => {
      try {
        const p = JSON.parse(buf);
        done(p?.success && Array.isArray(p.data) ? p.data : null);
      } catch {
        done(null);
      }
    });
    socket.on('error', () => {
      socket.destroy();
      done(null);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      done(null);
    });
  });
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readJson(file: string | null): unknown {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/* ---------- shared: the seat's "what is it doing now" strip ---------- */
function nowStrip(org: string, seat: string) {
  const root = getCTXRoot();
  const logDir = path.join(root, 'logs');
  const actFile = confined(logDir, seat, 'activity.log');
  const activityLog = actFile
    ? { exists: true, lines: lastLines(readTail(actFile, 32 * 1024), 10), source: `logs/${seat}/activity.log` }
    : {
        exists: false,
        lines: [] as string[],
        source: `logs/${seat}/activity.log`,
        note: 'this seat has no activity.log (the file does not exist), so there are no activity lines to show',
      };

  const out = confined(logDir, seat, 'stdout.log');
  let output: {
    last_output_at: string | null;
    screen: string[];
    source: string;
    note: string;
  };
  if (out) {
    const st = fs.statSync(out);
    output = {
      last_output_at: st.mtime.toISOString(),
      screen: ptyScreen(readTail(out, 96 * 1024), 12),
      source: `logs/${seat}/stdout.log (PTY log the daemon appends)`,
      note: 'the bottom of the terminal screen as the PTY log last drew it (cursor moves replayed, colours dropped); rows the log tail never repainted are missing',
    };
  } else {
    output = { last_output_at: null, screen: [], source: `logs/${seat}/stdout.log`, note: 'no PTY log for this seat' };
  }

  const evRoot = path.join(root, 'orgs', org, 'analytics', 'events');
  const evs = seatEvents(evRoot, seat, 10);
  return {
    activity_log: activityLog,
    output,
    events: {
      last: evs.length ? evs[evs.length - 1] : null,
      recent: evs,
      source: `orgs/${org}/analytics/events/${seat}/<day>.jsonl (bus event log, today + yesterday)`,
      note: evs.length ? null : 'no bus events from this seat today or yesterday',
    },
  };
}

/* ---------- 1. a crew figure = one task ---------- */
function inspectTask(org: string, id: string) {
  const taskDir = path.join(getCTXRoot(), 'orgs', org, 'tasks');
  const file = confined(taskDir, `${id}.json`);
  const t = readJson(file) as Record<string, unknown> | null;
  if (!t || t.id !== id) return null;

  const auditFile = confined(path.join(taskDir, 'audit'), `${id}.jsonl`);
  const audit: Array<Record<string, unknown>> = [];
  if (auditFile) {
    for (const line of fs.readFileSync(auditFile, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        audit.push({
          at: e.ts ?? null,
          event: e.event ?? null,
          who: e.agent ?? null,
          from: e.from ?? null,
          to: e.to ?? null,
          note: typeof e.note === 'string' ? e.note.slice(0, 280) : null,
        });
      } catch {
        /* skip malformed */
      }
    }
  }
  const annotations = Array.isArray(t.annotations) ? (t.annotations as Array<Record<string, unknown>>) : [];
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const result = t.result == null ? null : typeof t.result === 'string' ? t.result : JSON.stringify(t.result, null, 2);
  const seat = str(t.assigned_to);
  const startedAt = [...audit].reverse().find((e) => e.to === 'in_progress')?.at ?? null;
  const created = str(t.created_at);

  return {
    type: 'task' as const,
    id,
    title: str(t.title),
    status: str(t.status),
    assignee: seat,
    created_by: str(t.created_by),
    priority: str(t.priority),
    created_at: created,
    updated_at: str(t.updated_at),
    started_at: startedAt,
    age_seconds: created && !Number.isNaN(Date.parse(created)) ? Math.round((Date.now() - Date.parse(created)) / 1000) : null,
    description: str(t.description),
    notes: annotations.slice(-8).map((a) => ({ at: str(a.ts), who: str(a.agent), text: str(a.text) })),
    notes_total: annotations.length,
    result,
    audit: audit.slice(-40),
    audit_total: audit.length,
    paths: extractPaths(str(t.description), result, ...annotations.map((a) => str(a.text))),
    now: seat && validName(seat) ? nowStrip(org, seat) : null,
    sources: {
      task: `orgs/${org}/tasks/${id}.json`,
      audit: auditFile ? `orgs/${org}/tasks/audit/${id}.jsonl` : `orgs/${org}/tasks/audit/${id}.jsonl (absent)`,
    },
  };
}

/* ---------- 2. a worker pod ---------- */
interface DaemonWorker {
  name: string;
  status: string;
  pid?: number;
  dir?: string;
  parent?: string;
  spawnedAt?: string;
  exitCode?: number;
}

function inspectWorkerDir(dir: string | undefined) {
  const root = getCTXRoot();
  if (!dir) return { dir: null, note: 'the daemon did not report a dir', briefs: [], brief_path: null, branch: null, model_declared: null };
  const resolved = path.resolve(dir);
  const workersRoot = path.join(root, 'workers');
  const name = path.basename(resolved);
  /* confined to $CTX_ROOT/workers/<name>: a dir anywhere else is named, not read */
  if (path.dirname(resolved) !== workersRoot || !validName(name)) {
    return { dir: resolved, note: 'dir is outside $CTX_ROOT/workers; not read', briefs: [], brief_path: null, branch: null, model_declared: null };
  }
  const real = confined(workersRoot, name);
  if (!real) return { dir: resolved, note: 'dir does not exist', briefs: [], brief_path: null, branch: null, model_declared: null };
  const briefs = fs
    .readdirSync(real)
    .filter((f) => /^(WORKER-BRIEF[A-Za-z0-9_.-]*\.md|AGENTS\.md)$/.test(f))
    .map((f) => ({ file: f, path: path.join(resolved, f), mtime: fs.statSync(path.join(real, f)).mtime.toISOString() }))
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  const read = (f: string) => {
    const p = confined(real, f);
    return p ? readTail(p, 16 * 1024) : '';
  };
  const agentsMd = briefs.some((b) => b.file === 'AGENTS.md') ? read('AGENTS.md') : '';
  /* the brief AGENTS.md points at, else the newest WORKER-BRIEF*.md */
  const pointed = agentsMd.match(/(WORKER-BRIEF[A-Za-z0-9_.-]*\.md)/)?.[1];
  const brief = briefs.find((b) => b.file === pointed) ?? briefs.find((b) => b.file !== 'AGENTS.md') ?? null;
  const briefText = brief ? read(brief.file) : '';
  const branchRe = /\b(?:on|new)\s+branch\s+`?([A-Za-z0-9._-]+\/[A-Za-z0-9._\/-]+)/;
  const branch = agentsMd.match(branchRe)?.[1] ?? briefText.match(branchRe)?.[1] ?? null;
  const model =
    briefText.match(/actualModel:\s*`?([A-Za-z0-9._\/-]+)/)?.[1] ?? agentsMd.match(/actualModel:\s*`?([A-Za-z0-9._\/-]+)/)?.[1] ?? null;
  return { dir: resolved, note: null, briefs, brief_path: brief?.path ?? null, branch, model_declared: model };
}

async function inspectWorker(id: string) {
  const list = await daemonRequest<DaemonWorker>('list-workers');
  if (!list) return { unreachable: true as const };
  const w = list.find((x) => x.name === id);
  if (!w) return null;
  const alive = pidAlive(w.pid);
  const spawned = w.spawnedAt && !Number.isNaN(Date.parse(w.spawnedAt)) ? Date.parse(w.spawnedAt) : null;
  const d = inspectWorkerDir(w.dir);
  const logFile = confined(path.join(getCTXRoot(), 'logs'), id, 'stdout.log');
  return {
    type: 'worker' as const,
    id,
    name: w.name,
    status: w.status,
    running: w.status === 'running' && alive,
    parent: w.parent ?? null,
    pid: w.pid ?? null,
    pid_alive: alive,
    exit_code: w.exitCode ?? null,
    spawned_at: w.spawnedAt ?? null,
    uptime_seconds: spawned === null ? null : Math.round((Date.now() - spawned) / 1000),
    model: null,
    model_note: 'the daemon does not report a worker model',
    model_declared_by_brief: d.model_declared,
    dir: d.dir,
    dir_note: d.note,
    brief_path: d.brief_path,
    briefs: d.briefs,
    branch_named_by_brief: d.branch,
    output: logFile
      ? {
          last_output_at: fs.statSync(logFile).mtime.toISOString(),
          lines: ptyScreen(readTail(logFile, 128 * 1024), 30),
          source: `logs/${id}/stdout.log (PTY log the daemon keeps)`,
          note: 'the last 30 lines of the terminal screen as the PTY log last drew it (cursor moves replayed, colours dropped); rows the log tail never repainted are missing',
        }
      : { last_output_at: null, lines: [], source: `logs/${id}/stdout.log`, note: 'output not exposed by the daemon (no PTY log for this worker)' },
    sources: { worker: 'daemon IPC list-workers + pid signal-0 check', brief: 'files in the worker dir' },
  };
}

/* ---------- 3. a building = a seat ---------- */
interface DaemonStatus {
  name: string;
  status: string;
  pid?: number;
  uptime?: number;
  model?: string;
  configuredModel?: string;
  modelObserved?: boolean;
  modelMismatch?: boolean;
}

async function inspectSeat(org: string, id: string) {
  const root = getCTXRoot();
  const statuses = await daemonRequest<DaemonStatus>('status');
  const st = statuses?.find((s) => s.name === id) ?? null;

  /* in-progress tasks, the same store the crews are drawn from */
  const taskDir = path.join(root, 'orgs', org, 'tasks');
  const inProgress: Array<{ id: string; title: string | null; priority: string | null; updated_at: string | null }> = [];
  let tasksReadable = true;
  try {
    for (const f of fs.readdirSync(taskDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf-8'));
        if (t.assigned_to === id && t.status === 'in_progress' && !t.archived) {
          inProgress.push({ id: t.id, title: t.title ?? null, priority: t.priority ?? null, updated_at: t.updated_at ?? null });
        }
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    tasksReadable = false;
  }
  inProgress.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  /* pending inbox: count + last 3 */
  let inbox: { pending: number | null; last: Array<{ from: string | null; at: string | null; subject: string }>; note: string | null };
  const inboxDir = confined(path.join(root, 'inbox'), id);
  if (!inboxDir) inbox = { pending: 0, last: [], note: 'no inbox dir: nothing was ever queued' };
  else {
    try {
      const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
      const last = files.slice(-3).reverse().map((f) => {
        const m = readJson(confined(inboxDir, f)) as Record<string, unknown> | null;
        const text = typeof m?.text === 'string' ? m.text : '';
        const first = text.split('\n').find((l) => l.trim()) ?? '';
        return {
          from: typeof m?.from === 'string' ? m.from : null,
          at: typeof m?.timestamp === 'string' ? m.timestamp : null,
          subject: first.length > 110 ? first.slice(0, 109) + '…' : first || '(unreadable message)',
        };
      });
      inbox = { pending: files.length, last, note: null };
    } catch {
      inbox = { pending: null, last: [], note: 'inbox unreadable' };
    }
  }

  /* crons */
  const cronFile = confined(path.join(root, '.cortextOS', 'state', 'agents'), id, 'crons.json');
  const cronDoc = readJson(cronFile) as { crons?: Array<Record<string, unknown>> } | null;
  const crons = cronDoc?.crons
    ? cronDoc.crons.map((c) => ({
        name: typeof c.name === 'string' ? c.name : null,
        schedule: typeof c.schedule === 'string' ? c.schedule : typeof c.cron === 'string' ? c.cron : null,
        enabled: c.enabled !== false,
        last_fired_at: typeof c.last_fired_at === 'string' ? c.last_fired_at : null,
        fire_count: typeof c.fire_count === 'number' ? c.fire_count : null,
      }))
    : null;

  const now = nowStrip(org, id);
  return {
    type: 'seat' as const,
    id,
    live: statuses
      ? {
          status: st?.status ?? 'absent',
          running: st?.status === 'running',
          pid: st?.pid ?? null,
          uptime_seconds: st?.uptime ?? null,
          model: st ? (st.modelObserved === false ? null : st.model ?? null) : null,
          configured_model: st?.configuredModel ?? null,
          model_mismatch: st?.modelMismatch ?? null,
          source: 'daemon IPC status (what `cortextos status` prints)',
        }
      : { status: null, running: null, pid: null, uptime_seconds: null, model: null, source: 'daemon IPC status — UNREACHABLE (unknown)' },
    last_output_at: now.output.last_output_at,
    in_progress: tasksReadable ? inProgress : null,
    inbox: { ...inbox, source: `inbox/${id}/*.json (pending, not yet read)` },
    crons,
    crons_note: cronFile ? (crons ? null : 'crons.json unreadable') : 'no crons.json for this seat',
    now,
    sources: {
      tasks: `orgs/${org}/tasks/*.json (assigned_to=${id}, status=in_progress)`,
      crons: `.cortextOS/state/agents/${id}/crons.json`,
    },
  };
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const type = sp.get('type');
  const id = sp.get('id');
  const orgParam = sp.get('org');
  if (type !== 'task' && type !== 'worker' && type !== 'seat') return bad(400, 'type must be task, worker or seat');
  if (!validName(id)) return bad(400, 'invalid id');
  const orgs = getOrgs();
  const org = orgParam ?? process.env.CTX_ORG ?? orgs[0] ?? null;
  if (!org || !validName(org) || !orgs.includes(org)) return bad(400, 'unknown org');

  try {
    let doc: Record<string, unknown> | null;
    if (type === 'task') {
      doc = inspectTask(org, id);
    } else if (type === 'worker') {
      const w = await inspectWorker(id);
      if (w && 'unreachable' in w) {
        return Response.json(
          { error: 'daemon unreachable: worker state unknown', read_at: new Date().toISOString() },
          { status: 503 }
        );
      }
      doc = w;
    } else {
      const roster = getAllAgents()
        .filter((a) => a.org === org)
        .map((a) => a.name);
      doc = roster.includes(id) ? await inspectSeat(org, id) : null;
    }
    if (!doc) return bad(404, `no ${type} named ${id}`);
    return Response.json({ ...doc, org, read_at: new Date().toISOString() });
  } catch (err) {
    if (err instanceof ConfinementError) return bad(400, 'refused path');
    console.error('[api/city-inspect] failed:', err);
    return bad(500, 'Failed to read records');
  }
}

