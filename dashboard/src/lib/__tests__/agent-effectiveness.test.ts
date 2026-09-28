import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Temp CTX_ROOT before db.ts evaluates, so the test DB is never the live one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'effectiveness-test-'));
process.env.CTX_ROOT = tmpDir;

let db: typeof import('../db')['db'];
let getAgentEffectiveness: typeof import('../data/analytics')['getAgentEffectiveness'];

const ORG = 'eff-org';
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * 86400 * 1000).toISOString();

beforeAll(async () => {
  db = (await import('../db')).db;
  getAgentEffectiveness = (await import('../data/analytics')).getAgentEffectiveness;

  const task = db.prepare(
    `INSERT INTO tasks (id, title, status, assignee, org, created_at, completed_at)
     VALUES (?, 't', ?, 'eff-agent', ?, ?, ?)`,
  );
  // 6 completed, 2 pending, 1 in_progress, 3 blocked, 2 cancelled = 14
  const statuses = [
    ...Array(6).fill('completed'), 'pending', 'pending', 'in_progress',
    'blocked', 'blocked', 'blocked', 'cancelled', 'cancelled',
  ];
  statuses.forEach((s, i) =>
    task.run(`eff-t${i}`, s, ORG, iso(20), s === 'completed' ? iso(1) : null),
  );

  const ev = db.prepare(
    `INSERT INTO events (id, timestamp, agent, org, type, category, severity, message)
     VALUES (?, ?, 'eff-agent', ?, ?, ?, ?, 'x')`,
  );
  ev.run('e1', iso(30), ORG, 'error', 'error', 'error'); // old error
  ev.run('e2', iso(2), ORG, 'error', 'error', 'critical'); // recent critical
  ev.run('e3', iso(1), ORG, 'error', 'error', 'warning'); // writer said warning
  ev.run('e4', iso(1), ORG, 'error', 'error', 'info'); // probe
  ev.run('e5', iso(1), ORG, 'action', 'action', 'error'); // not category error
});

describe('getAgentEffectiveness', () => {
  it('errors honour the event severity; warnings are counted, not dropped', () => {
    const a = getAgentEffectiveness(ORG).find((r) => r.name === 'eff-agent')!;
    expect(a.errorCount).toBe(2);
    expect(a.errorsRecent).toBe(1);
    expect(a.warningCount).toBe(2);
  });

  it('rate excludes blocked and cancelled from the denominator and reports them', () => {
    const a = getAgentEffectiveness(ORG).find((r) => r.name === 'eff-agent')!;
    expect(a.tasksCompleted).toBe(6);
    expect(a.completionRate).toBeCloseTo((6 / 9) * 100, 5); // 14 - 3 blocked - 2 cancelled
    expect(a.blockedCount).toBe(3);
    expect(a.cancelledCount).toBe(2);
  });
});
