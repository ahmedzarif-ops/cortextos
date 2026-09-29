// cortextOS Dashboard - Analytics data queries
// Aggregated metrics for charts on the analytics page.

import { db } from '@/lib/db';
import type { AgentStat } from '@/components/analytics/agent-effectiveness';

/**
 * Get daily completed task counts for the last N days.
 */
export function getTaskThroughput(
  days: number = 30,
  org?: string,
): Array<{ date: string; tasks: number }> {
  const conditions: string[] = [
    "completed_at >= DATE('now', ?)",
    "status = 'completed'",
  ];
  const params: (string | number)[] = [`-${days} days`];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    return db
      .prepare(
        `SELECT DATE(completed_at) as date, COUNT(*) as tasks
         FROM tasks ${where}
         GROUP BY DATE(completed_at)
         ORDER BY date ASC`,
      )
      .all(...params) as Array<{ date: string; tasks: number }>;
  } catch {
    return [];
  }
}

/**
 * Get per-agent effectiveness stats.
 */
export function getAgentEffectiveness(org?: string): AgentStat[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    // Get all agents with their task stats
    const rows = db
      .prepare(
        `SELECT
           assignee as name,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
         FROM tasks
         ${where ? where + ' AND' : 'WHERE'} assignee IS NOT NULL AND assignee != ''
         GROUP BY assignee`,
      )
      .all(...params) as Array<{
      name: string;
      total: number;
      completed: number;
      blocked: number;
      cancelled: number;
    }>;

    // Error counts per agent from events. An event is an error when its
    // category is 'error' (sync.ts stores category in `type`) AND its own
    // severity says so. Category-'error' events the writer marked warning/info
    // (a failure recovered on retry, a finding about someone else's code, a
    // probe) are counted separately as warnings, not dropped, and `errorsRecent`
    // gives the last-7-day slice so a fixed-weeks-ago backlog reads as such.
    const recentCutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const errorRows = db
      .prepare(
        `SELECT agent as name,
           SUM(CASE WHEN severity IN ('error', 'critical') THEN 1 ELSE 0 END) as errors,
           SUM(CASE WHEN severity IN ('error', 'critical') AND timestamp >= ? THEN 1 ELSE 0 END) as errorsRecent,
           SUM(CASE WHEN severity IN ('error', 'critical') THEN 0 ELSE 1 END) as warnings
         FROM events
         ${where ? where + ' AND' : 'WHERE'} type = 'error'
         GROUP BY agent`,
      )
      .all(recentCutoff, ...params) as Array<{
      name: string;
      errors: number;
      errorsRecent: number;
      warnings: number;
    }>;

    const errorMap = new Map(errorRows.map((r) => [r.name, r]));

    // Get daily completed tasks for the last 7 days (for sparklines)
    const trendRows = db
      .prepare(
        `SELECT assignee as name, DATE(completed_at) as date, COUNT(*) as count
         FROM tasks
         WHERE completed_at >= DATE('now', '-7 days')
           AND status = 'completed'
           AND assignee IS NOT NULL AND assignee != ''
         GROUP BY assignee, DATE(completed_at)
         ORDER BY date ASC`,
      )
      .all() as Array<{ name: string; date: string; count: number }>;

    // Build trend map: agent -> [7 days of counts]
    const trendMap = new Map<string, number[]>();
    for (const row of trendRows) {
      if (!trendMap.has(row.name)) {
        trendMap.set(row.name, new Array(7).fill(0));
      }
      // Figure out which index (0-6) this date falls into
      const dayDiff = Math.floor(
        (Date.now() - new Date(row.date).getTime()) / (86400 * 1000),
      );
      const idx = 6 - Math.min(dayDiff, 6);
      const arr = trendMap.get(row.name)!;
      arr[idx] = row.count;
    }

    // Completion rate is completed / tasks the agent could have finished.
    // Blocked (waiting on someone else, usually the owner) and cancelled (a
    // decision, not a failure) leave the denominator; both are returned so the
    // card shows them instead of hiding them. Pending and in-progress stay in:
    // an agent's own open backlog is a fair charge against its rate.
    return rows.map((row) => {
      const actionable = row.total - row.blocked - row.cancelled;
      return {
        name: row.name,
        completionRate: actionable > 0 ? (row.completed / actionable) * 100 : 0,
        blockedCount: row.blocked,
        cancelledCount: row.cancelled,
        errorCount: errorMap.get(row.name)?.errors ?? 0,
        errorsRecent: errorMap.get(row.name)?.errorsRecent ?? 0,
        warningCount: errorMap.get(row.name)?.warnings ?? 0,
        tasksCompleted: row.completed,
        recentTrend: trendMap.get(row.name) ?? [0, 0, 0, 0, 0, 0, 0],
      };
    });
  } catch {
    return [];
  }
}
