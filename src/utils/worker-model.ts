import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { stripBom } from './strip-bom.js';

/**
 * Resolve the Claude model for a spawned worker.
 *
 * Order: an explicit `--model` wins; else the org's `worker_default_model` from
 * `orgs/<org>/context.json`; else undefined, which means the worker runs on this
 * machine's Claude Code default (`~/.claude/settings.json` "model"). Before this
 * existed, the `--model` help text said "defaults to org default" while no org
 * default was read anywhere, so every model-less worker silently ran the machine
 * default (measured 2026-09-28: `opus[1m]`).
 */
export function resolveWorkerModel(
  explicit: string | undefined,
  projectRoot: string | undefined,
  org: string | undefined,
): { model: string | undefined; source: 'flag' | 'org' | 'machine-default' } {
  const flag = explicit?.trim();
  if (flag) return { model: flag, source: 'flag' };
  if (projectRoot && org) {
    const contextPath = join(projectRoot, 'orgs', org, 'context.json');
    try {
      if (existsSync(contextPath)) {
        const ctx = JSON.parse(stripBom(readFileSync(contextPath, 'utf-8')));
        const m = typeof ctx.worker_default_model === 'string' ? ctx.worker_default_model.trim() : '';
        if (m) return { model: m, source: 'org' };
      }
    } catch {
      /* unreadable context.json: fall through to the machine default, and say so */
    }
  }
  return { model: undefined, source: 'machine-default' };
}
