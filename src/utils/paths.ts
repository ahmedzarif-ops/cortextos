import { homedir } from 'os';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { validateInstanceId } from './validate.js';

/**
 * The state root for an instance. Honours CTX_ROOT the way _ctx-env.sh and
 * resolveEnv() already do — but only for the environment's OWN instance, so an
 * explicit request for another instance still lands under ~/.cortextos/<id>.
 *
 * BUG-FIX 2026-09-28: this used to ignore CTX_ROOT entirely. `npm test` sets
 * CTX_ROOT to a temp dir, yet every bus write that went through resolvePaths
 * (telegram_sent, heartbeat events, ...) landed in the LIVE event log:
 * 2,232 `test-agent` telegram_sent events had accumulated there.
 */
export function resolveCtxRoot(instanceId: string = 'default'): string {
  const envRoot = process.env.CTX_ROOT;
  const envInstance = process.env.CTX_INSTANCE_ID || 'default';
  if (envRoot && instanceId === envInstance) return envRoot;
  return join(homedir(), '.cortextos', instanceId);
}

/**
 * Resolve all bus paths for an agent.
 * Mirrors the path resolution in bash _ctx-env.sh.
 *
 * The directory layout is:
 *   ~/.cortextos/{instance}/
 *     config/                - enabled-agents.json
 *     state/{agent}/         - flat, per-agent subdirs
 *     state/{agent}/heartbeat.json - canonical heartbeat location
 *     state/oauth/           - OAuth accounts.json (token store)
 *     state/usage/           - Usage monitoring snapshots
 *     inbox/{agent}/         - flat (not org-nested)
 *     inflight/{agent}/      - flat
 *     processed/{agent}/     - flat
 *     outbox/{agent}/        - flat
 *     logs/{agent}/          - flat
 *     orgs/{org}/tasks/      - org-scoped
 *     orgs/{org}/approvals/  - org-scoped
 *     orgs/{org}/analytics/  - org-scoped
 */
export function resolvePaths(
  agentName: string,
  instanceId: string = 'default',
  org?: string,
  ctxRootOverride?: string,
): BusPaths {
  validateInstanceId(instanceId);
  const ctxRoot = ctxRootOverride || resolveCtxRoot(instanceId);

  // Org-scoped paths for tasks, approvals, analytics
  const orgBase = org ? join(ctxRoot, 'orgs', org) : ctxRoot;

  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agentName),
    inflight: join(ctxRoot, 'inflight', agentName),
    processed: join(ctxRoot, 'processed', agentName),
    logDir: join(ctxRoot, 'logs', agentName),
    stateDir: join(ctxRoot, 'state', agentName),
    taskDir: join(orgBase, 'tasks'),
    approvalDir: join(orgBase, 'approvals'),
    analyticsDir: join(orgBase, 'analytics'),
    deliverablesDir: join(orgBase, 'deliverables'),
  };
}

/**
 * Get the IPC socket path for daemon communication.
 * Unix domain socket on macOS/Linux, named pipe on Windows.
 */
export function getIpcPath(instanceId: string = 'default'): string {
  validateInstanceId(instanceId);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cortextos-${instanceId}`;
  }
  return join(homedir(), '.cortextos', instanceId, 'daemon.sock');
}
