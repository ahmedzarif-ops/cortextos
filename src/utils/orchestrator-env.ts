import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Resolve an org's orchestrator agent from `orgs/<org>/context.json`.
 *
 * Shared by AgentPTY and CodexAppServerPTY. The two adapters build their PTY
 * environments independently, and this variable existed in one and not the
 * other — a Codex seat had no CTX_ORCHESTRATOR_AGENT and so could not route
 * to its orchestrator. The parsing lives here once; each adapter still writes
 * the variable itself, so a source-level parity test can see both.
 *
 * Returns undefined — never throws — when the org, the file, or the field is
 * missing or malformed. An unset variable is recoverable; a daemon that will
 * not start is not.
 */
export function resolveOrchestratorAgent(
  projectRoot: string | undefined,
  org: string | undefined,
): string | undefined {
  if (!projectRoot || !org) return undefined;
  try {
    const contextPath = join(projectRoot, 'orgs', org, 'context.json');
    if (!existsSync(contextPath)) return undefined;
    const ctx = JSON.parse(readFileSync(contextPath, 'utf-8')) as { orchestrator?: unknown };
    return typeof ctx.orchestrator === 'string' && ctx.orchestrator.trim()
      ? ctx.orchestrator.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
