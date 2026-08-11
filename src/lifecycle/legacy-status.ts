import { spawnSync } from 'child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { createConnection } from 'net';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import type { AgentStatus } from '../types/index.js';
import { getIpcPath } from '../utils/paths.js';
import { stripBom } from '../utils/strip-bom.js';
import { CORTEXTOS_VERSION } from '../version.js';
import type {
  LifecycleStatusSnapshot,
  OverallStatus,
  StatusObservation,
  StatusSeverity,
} from './status-types.js';

const INSTANCE_ID_RE = /^[a-z0-9_-]+$/;
const CANONICAL_AGENT_ID_RE = /^[a-z0-9_-]+$/;
// Current-main creation paths require lowercase identifiers, but the legacy
// daemon has historically discovered directory names and registry keys without
// applying that validator. ASCII case is therefore observable migration input,
// not corruption. Keep this compatibility class deliberately narrow: accepting
// dots, whitespace, separators, control characters, or Unicode would make path
// and normalization behavior ambiguous across supported hosts.
const LEGACY_SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;
const HEARTBEAT_STALE_MS = 2 * 60 * 60 * 1000;
const HEARTBEAT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_IPC_RESPONSE_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const SAFE_GIT_CONFIG_ARGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
] as const;

const OBSERVATIONS: Record<string, Omit<StatusObservation, 'code'>> = {
  CORTEXT_STATUS_LEGACY_LAYOUT: {
    severity: 'info', domain: 'legacy',
    summary: 'An existing combined Cortext layout was detected.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_LEGACY_CAPABILITIES_LIMITED: {
    severity: 'info', domain: 'legacy',
    summary: 'Managed lifecycle authority is unavailable in the legacy bridge profile.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_LEGACY_ROOT_AUTHORITY_UNPROVEN: {
    severity: 'error', domain: 'legacy',
    summary: 'The selected custom state root cannot be bound to the legacy daemon identity.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_FRAMEWORK_NOT_FOUND: {
    severity: 'warning', domain: 'application',
    summary: 'The legacy application checkout could not be resolved.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_APPLICATION_VERSION_UNKNOWN: {
    severity: 'warning', domain: 'application',
    summary: 'The legacy application version could not be established.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_FRAMEWORK_MODIFIED: {
    severity: 'warning', domain: 'application',
    summary: 'The legacy framework checkout contains local modifications.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_VERSION_CONFLICT: {
    severity: 'warning', domain: 'application',
    summary: 'Legacy application version sources disagree.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_REGISTRY_INVALID: {
    severity: 'error', domain: 'runtime',
    summary: 'The enabled-agent registry is invalid or unreadable.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_AGENT_CONFIG_INVALID: {
    severity: 'error', domain: 'runtime',
    summary: 'At least one agent configuration is invalid or unreadable.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_AGENT_ID_INVALID: {
    severity: 'error', domain: 'runtime',
    summary: 'At least one legacy agent or organization identifier is invalid.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_LEGACY_AGENT_ID_NONCANONICAL: {
    severity: 'warning', domain: 'runtime',
    summary: 'At least one observable legacy agent or organization identifier requires canonicalization.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_LEGACY_AGENT_NAME_COLLISION: {
    severity: 'error', domain: 'runtime',
    summary: 'Multiple configured agents cannot be distinguished safely by legacy or canonical identity mapping.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_HEARTBEAT_INVALID: {
    severity: 'warning', domain: 'runtime',
    summary: 'At least one existing heartbeat is invalid or unreadable.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_DAEMON_ENDPOINT_STALE: {
    severity: 'warning', domain: 'runtime',
    summary: 'The daemon endpoint refused a local connection.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_DAEMON_TIMEOUT: {
    severity: 'error', domain: 'runtime',
    summary: 'The daemon status request timed out.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_DAEMON_RESPONSE_INVALID: {
    severity: 'error', domain: 'runtime',
    summary: 'The daemon returned an invalid status response.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_DAEMON_STATUS_UNKNOWN: {
    severity: 'error', domain: 'runtime',
    summary: 'The daemon status could not be determined.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_AGENT_EXPECTED_MISSING: {
    severity: 'warning', domain: 'runtime',
    summary: 'At least one enabled agent is absent from responsive daemon status.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_DISABLED_PROCESS_ACTIVE: {
    severity: 'error', domain: 'runtime',
    summary: 'At least one disabled agent process is active.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_UNREGISTERED_PROCESS_ACTIVE: {
    severity: 'error', domain: 'runtime',
    summary: 'At least one unregistered agent process is active.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_AGENT_DEGRADED: {
    severity: 'warning', domain: 'runtime',
    summary: 'At least one observed agent process is degraded.',
    recommended_operation: null,
  },
  CORTEXT_STATUS_STATE_UNREADABLE: {
    severity: 'critical', domain: 'state',
    summary: 'The selected legacy state root is unreadable or invalid.',
    recommended_operation: null,
  },
};

const SEVERITY_ORDER: Record<StatusSeverity, number> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
};

export type LegacyDaemonProbe =
  | { kind: 'responsive'; statuses: AgentStatus[] }
  | { kind: 'absent' | 'refused' | 'timeout' | 'invalid' | 'unknown' };

export interface CollectLegacyStatusOptions {
  instanceId?: string;
  ctxRoot?: string;
  frameworkRoot?: string;
  includePaths?: boolean;
  now?: Date;
  homeDir?: string;
  cwd?: string;
  probeDaemon?: (instanceId: string) => Promise<LegacyDaemonProbe>;
  pidAlive?: (pid: number) => boolean;
}

export class LegacyStatusCollectionError extends Error {
  constructor(
    public readonly code:
      | 'CORTEXT_STATUS_INVALID_INSTANCE'
      | 'CORTEXT_STATUS_INSTANCE_NOT_FOUND'
      | 'CORTEXT_STATUS_INSTANCE_AMBIGUOUS',
    public readonly candidateCount?: number,
  ) {
    super(code);
  }
}

interface JsonReadResult {
  kind: 'missing' | 'ok' | 'invalid';
  value?: unknown;
}

interface AgentDefinition {
  identity: string;
  name: string;
  dir: string | null;
  enabledFromConfig: boolean | null;
  enabledFromRegistry: boolean | null;
}

interface AgentInventory {
  configured: number | null;
  enabled: number | null;
  configuredNames: Set<string>;
  enabledNames: Set<string> | null;
  disabledNames: Set<string> | null;
  collision: boolean;
  sourceInvalid: boolean;
  recentHeartbeats: number | null;
  staleHeartbeats: number | null;
}

function readJson(path: string): JsonReadResult {
  if (!existsSync(path)) return { kind: 'missing' };
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > MAX_JSON_BYTES) return { kind: 'invalid' };
    return { kind: 'ok', value: JSON.parse(stripBom(readFileSync(path, 'utf-8'))) };
  } catch {
    return { kind: 'invalid' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function packageVersion(path: string): { kind: 'missing' | 'invalid' | 'ok'; version?: string } {
  const result = readJson(path);
  if (result.kind !== 'ok') return { kind: result.kind };
  if (
    !isRecord(result.value)
    || typeof result.value.version !== 'string'
    || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(result.value.version)
  ) return { kind: 'invalid' };
  return { kind: 'ok', version: result.value.version };
}

function isLegacyFrameworkRoot(path: string): boolean {
  const packageResult = readJson(join(path, 'package.json'));
  return packageResult.kind === 'ok'
    && isRecord(packageResult.value)
    && packageResult.value.name === 'cortextos';
}

function isLegacyInstanceRoot(path: string): boolean {
  if (!readableDirectory(path)) return false;
  return ['config', 'state', 'inbox', 'logs', 'orgs', 'daemon.sock']
    .some(marker => existsSync(join(path, marker)));
}

function discoverLegacyInstances(home: string): string[] {
  const instancesRoot = join(home, '.cortextos');
  if (!existsSync(instancesRoot)) return [];
  const entries = readdirSync(instancesRoot, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && INSTANCE_ID_RE.test(entry.name))
    .filter(entry => isLegacyInstanceRoot(join(instancesRoot, entry.name)))
    .map(entry => entry.name)
    .sort();
}

function gitOutput(frameworkRoot: string, args: string[]): string | null {
  const result = spawnSync('git', [...SAFE_GIT_CONFIG_ARGS, ...args], {
    cwd: frameworkRoot,
    encoding: 'utf-8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    timeout: 3000,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout.trim();
}

function gitModificationStatus(frameworkRoot: string): 'clean' | 'modified' | 'unknown' {
  const result = spawnSync('git', [
    ...SAFE_GIT_CONFIG_ARGS,
    'status', '--porcelain=v1', '--untracked-files=normal',
  ], {
    cwd: frameworkRoot,
    encoding: 'utf-8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    timeout: 3000,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') return 'modified';
  if (result.status !== 0 || typeof result.stdout !== 'string') return 'unknown';
  return result.stdout.length === 0 ? 'clean' : 'modified';
}

function resolveFrameworkRoot(options: CollectLegacyStatusOptions): string | null {
  const home = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const candidates = [
    options.frameworkRoot,
    process.env.CTX_FRAMEWORK_ROOT,
    process.env.CTX_PROJECT_ROOT,
    join(home, 'cortextos'),
    cwd,
  ].filter((candidate): candidate is string => !!candidate);

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (isLegacyFrameworkRoot(resolved)) return resolved;
  }
  return null;
}

function listAgentDirectories(
  frameworkRoot: string,
  addObservation: (code: string, partial?: boolean) => void,
): { definitions: AgentDefinition[]; invalid: boolean } {
  const definitions: AgentDefinition[] = [];
  let invalid = false;

  const addAgentDir = (org: string, name: string, dir: string) => {
    const nameSafe = LEGACY_SAFE_AGENT_ID_RE.test(name);
    const orgSafe = org === '@root' || LEGACY_SAFE_AGENT_ID_RE.test(org);
    if (!nameSafe || !orgSafe) {
      addObservation('CORTEXT_STATUS_AGENT_ID_INVALID', true);
      invalid = true;
    } else if (
      !CANONICAL_AGENT_ID_RE.test(name)
      || (org !== '@root' && !CANONICAL_AGENT_ID_RE.test(org))
    ) {
      addObservation('CORTEXT_STATUS_LEGACY_AGENT_ID_NONCANONICAL');
    }
    definitions.push({
      identity: `${org}/${name}`,
      name,
      // Do not open files below identifiers outside the bounded compatibility
      // class. Their presence is countable, but their contents are not trusted.
      dir: nameSafe && orgSafe ? dir : null,
      enabledFromConfig: null,
      enabledFromRegistry: null,
    });
  };

  const flatRoot = join(frameworkRoot, 'agents');
  if (existsSync(flatRoot)) {
    try {
      for (const entry of readdirSync(flatRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) addAgentDir('@root', entry.name, join(flatRoot, entry.name));
      }
    } catch {
      addObservation('CORTEXT_STATUS_AGENT_CONFIG_INVALID', true);
      invalid = true;
    }
  }

  const orgsRoot = join(frameworkRoot, 'orgs');
  if (existsSync(orgsRoot)) {
    try {
      for (const orgEntry of readdirSync(orgsRoot, { withFileTypes: true })) {
        if (!orgEntry.isDirectory()) continue;
        const agentsRoot = join(orgsRoot, orgEntry.name, 'agents');
        if (!existsSync(agentsRoot)) continue;
        try {
          for (const agentEntry of readdirSync(agentsRoot, { withFileTypes: true })) {
            if (agentEntry.isDirectory()) {
              addAgentDir(orgEntry.name, agentEntry.name, join(agentsRoot, agentEntry.name));
            }
          }
        } catch {
          addObservation('CORTEXT_STATUS_AGENT_CONFIG_INVALID', true);
          invalid = true;
        }
      }
    } catch {
      addObservation('CORTEXT_STATUS_AGENT_CONFIG_INVALID', true);
      invalid = true;
    }
  }

  for (const definition of definitions) {
    if (!definition.dir) continue;
    const config = readJson(join(definition.dir, 'config.json'));
    if (config.kind === 'missing') continue;
    if (config.kind !== 'ok' || !isRecord(config.value)) {
      addObservation('CORTEXT_STATUS_AGENT_CONFIG_INVALID', true);
      invalid = true;
      continue;
    }
    definition.enabledFromConfig = config.value.enabled === false ? false : true;
  }

  return { definitions, invalid };
}

function collectAgentInventory(
  frameworkRoot: string | null,
  ctxRoot: string,
  nowMs: number,
  addObservation: (code: string, partial?: boolean) => void,
): AgentInventory {
  if (!frameworkRoot) {
    return {
      configured: null,
      enabled: null,
      configuredNames: new Set(),
      enabledNames: null,
      disabledNames: null,
      collision: false,
      sourceInvalid: true,
      recentHeartbeats: null,
      staleHeartbeats: null,
    };
  }

  const directoryResult = listAgentDirectories(frameworkRoot, addObservation);
  const definitions = directoryResult.definitions;
  let sourceInvalid = directoryResult.invalid;
  const registryResult = readJson(join(ctxRoot, 'config', 'enabled-agents.json'));
  let registry: Record<string, unknown> = {};
  if (registryResult.kind === 'invalid' || (registryResult.kind === 'ok' && !isRecord(registryResult.value))) {
    addObservation('CORTEXT_STATUS_REGISTRY_INVALID', true);
    sourceInvalid = true;
  } else if (registryResult.kind === 'ok') {
    registry = registryResult.value as Record<string, unknown>;
  }

  const byName = new Map<string, AgentDefinition[]>();
  for (const definition of definitions) {
    const matches = byName.get(definition.name) ?? [];
    matches.push(definition);
    byName.set(definition.name, matches);
  }

  for (const [name, rawEntry] of Object.entries(registry)) {
    if (!LEGACY_SAFE_AGENT_ID_RE.test(name) || !isRecord(rawEntry)) {
      addObservation('CORTEXT_STATUS_REGISTRY_INVALID', true);
      sourceInvalid = true;
      continue;
    }
    if (!CANONICAL_AGENT_ID_RE.test(name)) {
      addObservation('CORTEXT_STATUS_LEGACY_AGENT_ID_NONCANONICAL');
    }
    const org = typeof rawEntry.org === 'string' ? rawEntry.org : null;
    if (org && !LEGACY_SAFE_AGENT_ID_RE.test(org)) {
      addObservation('CORTEXT_STATUS_REGISTRY_INVALID', true);
      sourceInvalid = true;
      continue;
    }
    if (org && !CANONICAL_AGENT_ID_RE.test(org)) {
      addObservation('CORTEXT_STATUS_LEGACY_AGENT_ID_NONCANONICAL');
    }

    let definition: AgentDefinition | undefined;
    if (org) {
      definition = definitions.find(item => item.identity === `${org}/${name}`);
    } else {
      const matches = byName.get(name) ?? [];
      if (matches.length === 1) definition = matches[0];
    }

    if (!definition) {
      definition = {
        identity: `${org ?? '@registry'}/${name}`,
        name,
        dir: null,
        enabledFromConfig: null,
        enabledFromRegistry: null,
      };
      definitions.push(definition);
      const matches = byName.get(name) ?? [];
      matches.push(definition);
      byName.set(name, matches);
    }
    definition.enabledFromRegistry = rawEntry.enabled === false ? false : true;
  }

  const caseFoldedNames = new Map<string, Set<string>>();
  for (const name of byName.keys()) {
    const variants = caseFoldedNames.get(name.toLowerCase()) ?? new Set<string>();
    variants.add(name);
    caseFoldedNames.set(name.toLowerCase(), variants);
  }
  const collision = [...byName.values()].some(items => items.length > 1)
    || [...caseFoldedNames.values()].some(variants => variants.size > 1);
  if (collision) addObservation('CORTEXT_STATUS_LEGACY_AGENT_NAME_COLLISION');

  const configuredNames = new Set(definitions.map(item => item.name));
  let enabledNames: Set<string> | null = new Set();
  let disabledNames: Set<string> | null = new Set();

  if (collision || sourceInvalid) {
    enabledNames = null;
    disabledNames = null;
  } else {
    for (const definition of definitions) {
      const enabled = definition.enabledFromConfig !== false && definition.enabledFromRegistry !== false;
      (enabled ? enabledNames : disabledNames).add(definition.name);
    }
  }

  let recentHeartbeats: number | null = 0;
  let staleHeartbeats: number | null = 0;
  if (collision) {
    recentHeartbeats = null;
    staleHeartbeats = null;
  } else {
    for (const name of configuredNames) {
      if (!LEGACY_SAFE_AGENT_ID_RE.test(name)) continue;
      const heartbeat = readJson(join(ctxRoot, 'state', name, 'heartbeat.json'));
      if (heartbeat.kind === 'missing') continue;
      if (heartbeat.kind !== 'ok' || !isRecord(heartbeat.value)) {
        addObservation('CORTEXT_STATUS_HEARTBEAT_INVALID', true);
        continue;
      }
      const rawTimestamp = typeof heartbeat.value.last_heartbeat === 'string'
        ? heartbeat.value.last_heartbeat
        : typeof heartbeat.value.timestamp === 'string'
          ? heartbeat.value.timestamp
          : null;
      const timestamp = rawTimestamp ? Date.parse(rawTimestamp) : NaN;
      if (!Number.isFinite(timestamp) || timestamp > nowMs + HEARTBEAT_FUTURE_TOLERANCE_MS) {
        addObservation('CORTEXT_STATUS_HEARTBEAT_INVALID', true);
        continue;
      }
      if (nowMs - timestamp < HEARTBEAT_STALE_MS) recentHeartbeats += 1;
      else staleHeartbeats += 1;
    }
  }

  return {
    configured: definitions.length,
    enabled: enabledNames?.size ?? null,
    configuredNames,
    enabledNames,
    disabledNames,
    collision,
    sourceInvalid,
    recentHeartbeats,
    staleHeartbeats,
  };
}

export function isLegacyAgentStatus(value: unknown): value is AgentStatus {
  if (
    !isRecord(value)
    || typeof value.name !== 'string'
    || !LEGACY_SAFE_AGENT_ID_RE.test(value.name)
  ) return false;
  if (!['running', 'stopped', 'crashed', 'starting', 'halted'].includes(String(value.status))) {
    return false;
  }
  if (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0)) {
    return false;
  }
  if (value.awaitingConfirmation !== undefined && typeof value.awaitingConfirmation !== 'boolean') {
    return false;
  }
  return true;
}

export function probeLegacyDaemon(instanceId: string): Promise<LegacyDaemonProbe> {
  const socketPath = getIpcPath(instanceId);
  return new Promise(resolveProbe => {
    let settled = false;
    let data = '';
    let receivedBytes = 0;
    const finish = (result: LegacyDaemonProbe) => {
      if (settled) return;
      settled = true;
      resolveProbe(result);
    };

    const socket = createConnection(socketPath, () => {
      socket.write(JSON.stringify({ type: 'status', source: 'cortextos lifecycle status' }));
    });

    socket.on('data', chunk => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_IPC_RESPONSE_BYTES) {
        finish({ kind: 'invalid' });
        socket.destroy();
        return;
      }
      data += chunk.toString();
    });
    socket.on('end', () => {
      try {
        const response = JSON.parse(data) as { success?: unknown; data?: unknown };
        if (response.success !== true || !Array.isArray(response.data) || !response.data.every(isLegacyAgentStatus)) {
          finish({ kind: 'invalid' });
          return;
        }
        const names = response.data.map(item => item.name);
        if (new Set(names).size !== names.length) {
          finish({ kind: 'invalid' });
          return;
        }
        finish({ kind: 'responsive', statuses: response.data });
      } catch {
        finish({ kind: 'invalid' });
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') finish({ kind: 'absent' });
      else if (error.code === 'ECONNREFUSED') finish({ kind: 'refused' });
      else finish({ kind: 'unknown' });
    });
    socket.setTimeout(5000, () => {
      socket.destroy();
      finish({ kind: 'timeout' });
    });
  });
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function observationList(codes: Set<string>): StatusObservation[] {
  return [...codes]
    .map(code => ({ code, ...OBSERVATIONS[code] }))
    .filter((item): item is StatusObservation => !!item.summary)
    .sort((a, b) => {
      const severity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (severity !== 0) return severity;
      return a.domain.localeCompare(b.domain) || a.code.localeCompare(b.code);
    });
}

function highestSeverity(observations: StatusObservation[]): StatusSeverity | null {
  return observations.length === 0 ? null : observations[0].severity;
}

function overallSummary(status: OverallStatus): string {
  const summaries: Record<OverallStatus, string> = {
    healthy: 'The detected legacy instance is running without a material observation.',
    degraded: 'The detected legacy instance is observable but needs attention.',
    stopped: 'The detected legacy daemon is stopped.',
    migrating: 'A lifecycle migration is active.',
    blocked: 'A legacy identity or state conflict blocks safe lifecycle decisions.',
    uninitialized: 'No managed instance is initialized.',
    unknown: 'The detected legacy instance could not be classified conclusively.',
  };
  return summaries[status];
}

export async function collectLegacyStatus(
  options: CollectLegacyStatusOptions = {},
): Promise<LifecycleStatusSnapshot> {
  const collectionStarted = options.now ?? new Date();
  const nowMs = collectionStarted.getTime();
  const home = options.homeDir ?? homedir();
  const explicitInstance = options.instanceId !== undefined;
  const environmentInstance = !explicitInstance ? process.env.CTX_INSTANCE_ID : undefined;
  const environmentRoot = !explicitInstance && !environmentInstance
    ? process.env.CTX_ROOT
    : undefined;
  let requestedInstance: string | null = null;
  let selectionSource: LifecycleStatusSnapshot['scope']['selection_source'];
  let instanceId: string;

  if (explicitInstance) {
    requestedInstance = options.instanceId!;
    instanceId = options.instanceId!;
    selectionSource = 'argument';
  } else if (environmentInstance) {
    requestedInstance = environmentInstance;
    instanceId = environmentInstance;
    selectionSource = 'legacy_environment';
  } else if (environmentRoot) {
    requestedInstance = basename(resolve(environmentRoot));
    instanceId = requestedInstance;
    selectionSource = 'legacy_environment';
  } else {
    const candidates = discoverLegacyInstances(home);
    if (candidates.length === 0) {
      throw new LegacyStatusCollectionError('CORTEXT_STATUS_INSTANCE_NOT_FOUND');
    }
    if (candidates.length > 1) {
      throw new LegacyStatusCollectionError('CORTEXT_STATUS_INSTANCE_AMBIGUOUS', candidates.length);
    }
    instanceId = candidates[0];
    selectionSource = 'only_instance';
  }
  if (!INSTANCE_ID_RE.test(instanceId)) {
    throw new LegacyStatusCollectionError('CORTEXT_STATUS_INVALID_INSTANCE');
  }

  const selectedRootInput = options.ctxRoot ?? process.env.CTX_ROOT;
  const canonicalCtxRoot = resolve(join(home, '.cortextos', instanceId));
  const ctxRoot = resolve(selectedRootInput ?? canonicalCtxRoot);
  if (!existsSync(ctxRoot)) {
    throw new LegacyStatusCollectionError('CORTEXT_STATUS_INSTANCE_NOT_FOUND');
  }

  const observationCodes = new Set<string>();
  let partial = false;
  const addObservation = (code: string, makesPartial = false) => {
    observationCodes.add(code);
    if (makesPartial) partial = true;
  };

  addObservation('CORTEXT_STATUS_LEGACY_CAPABILITIES_LIMITED');
  const customRootUnbound = options.ctxRoot === undefined
    && process.env.CTX_ROOT !== undefined
    && ctxRoot !== canonicalCtxRoot;
  if (customRootUnbound) {
    addObservation('CORTEXT_STATUS_LEGACY_ROOT_AUTHORITY_UNPROVEN', true);
  }

  const ctxRootReadable = readableDirectory(ctxRoot);
  const legacyStateDir = join(ctxRoot, 'state');
  const stateDirExists = existsSync(legacyStateDir);
  const stateReadable = ctxRootReadable && (!stateDirExists || readableDirectory(legacyStateDir));
  const stateStatus: LifecycleStatusSnapshot['state']['status'] = !ctxRootReadable
    ? 'unreadable'
    : !stateDirExists
      ? 'missing'
      : stateReadable
        ? 'readable'
        : 'unreadable';
  if (!stateReadable) addObservation('CORTEXT_STATUS_STATE_UNREADABLE', true);

  const frameworkRoot = resolveFrameworkRoot(options);
  if (frameworkRoot) addObservation('CORTEXT_STATUS_LEGACY_LAYOUT');
  else addObservation('CORTEXT_STATUS_FRAMEWORK_NOT_FOUND', true);

  const versionEvidence: LifecycleStatusSnapshot['application']['version_evidence'] = [];
  let rootVersion: string | null = null;
  let dashboardVersion: string | null = null;
  let sourceCommit: string | null = null;
  let gitBacked = false;
  let remoteStatus: LifecycleStatusSnapshot['instance']['remote_status'] = 'unknown';

  if (frameworkRoot) {
    const rootPackage = packageVersion(join(frameworkRoot, 'package.json'));
    if (rootPackage.kind === 'ok') {
      rootVersion = rootPackage.version!;
      versionEvidence.push({
        domain: 'application', source: 'root_package', authority: 'primary_legacy', value: rootVersion,
      });
    } else {
      addObservation('CORTEXT_STATUS_APPLICATION_VERSION_UNKNOWN', true);
    }

    const dashboardPackage = packageVersion(join(frameworkRoot, 'dashboard', 'package.json'));
    if (dashboardPackage.kind === 'ok') {
      dashboardVersion = dashboardPackage.version!;
      versionEvidence.push({
        domain: 'dashboard_component', source: 'dashboard_package', authority: 'component', value: dashboardVersion,
      });
    }

    sourceCommit = gitOutput(frameworkRoot, ['rev-parse', 'HEAD']);
    if (sourceCommit && /^[a-f0-9]{40,64}$/i.test(sourceCommit)) {
      gitBacked = true;
      versionEvidence.push({
        domain: 'source_provenance', source: 'git_commit', authority: 'provenance', value: sourceCommit,
      });
    } else {
      sourceCommit = null;
    }
    const remotes = gitOutput(frameworkRoot, ['remote']);
    remoteStatus = remotes === null ? 'unknown' : remotes.length > 0 ? 'configured_unverified' : 'none';
    if (gitBacked && gitModificationStatus(frameworkRoot) === 'modified') {
      addObservation('CORTEXT_STATUS_FRAMEWORK_MODIFIED');
    }
  }

  versionEvidence.push({
    domain: 'application', source: 'cli_metadata', authority: 'corroborating', value: CORTEXTOS_VERSION,
  });
  let applicationVersion: string | null = rootVersion;
  if (rootVersion && rootVersion !== CORTEXTOS_VERSION) {
    applicationVersion = null;
    addObservation('CORTEXT_STATUS_VERSION_CONFLICT');
  }
  if (!applicationVersion && !observationCodes.has('CORTEXT_STATUS_APPLICATION_VERSION_UNKNOWN')) {
    addObservation('CORTEXT_STATUS_APPLICATION_VERSION_UNKNOWN', true);
  }

  const inventory = collectAgentInventory(frameworkRoot, ctxRoot, nowMs, addObservation);
  const probe = await (options.probeDaemon ?? probeLegacyDaemon)(instanceId);
  const pidAlive = options.pidAlive ?? defaultPidAlive;

  let daemonStatus: LifecycleStatusSnapshot['runtime']['daemon']['status'];
  let ipcStatus: LifecycleStatusSnapshot['runtime']['daemon']['ipc_status'];
  let observedProcesses: number | null = null;
  let activeProcesses: number | null = null;
  let running: number | null = null;
  let starting: number | null = null;
  let stopped: number | null = null;
  let degraded: number | null = null;
  let expectedMissing: number | null = null;
  let unknownAgents: number | null = null;
  let disabledActive: number | null = null;
  let unregisteredActive: number | null = null;

  if (probe.kind === 'responsive') {
    daemonStatus = 'running';
    ipcStatus = 'responsive';
    observedProcesses = probe.statuses.length;
    activeProcesses = 0;
    running = 0;
    starting = 0;
    stopped = 0;
    degraded = 0;

    const observedNames = new Set<string>();
    const activeByName = new Map<string, boolean>();
    for (const status of probe.statuses) {
      observedNames.add(status.name);
      const isActive = status.status === 'running'
        || status.status === 'starting'
        || status.awaitingConfirmation === true
        || (typeof status.pid === 'number' && pidAlive(status.pid));
      activeByName.set(status.name, isActive);
      if (isActive) activeProcesses += 1;

      if (status.awaitingConfirmation) degraded += 1;
      else if (status.status === 'running') running += 1;
      else if (status.status === 'starting') starting += 1;
      else if (status.status === 'stopped') stopped += 1;
      else degraded += 1;
    }

    if ((degraded ?? 0) > 0) addObservation('CORTEXT_STATUS_AGENT_DEGRADED');

    if (inventory.enabledNames && !inventory.collision && !inventory.sourceInvalid) {
      expectedMissing = [...inventory.enabledNames].filter(name => !observedNames.has(name)).length;
      unknownAgents = expectedMissing;
      disabledActive = 0;
      unregisteredActive = 0;
      for (const status of probe.statuses) {
        if (!activeByName.get(status.name)) continue;
        if (inventory.disabledNames?.has(status.name)) disabledActive += 1;
        if (!inventory.configuredNames.has(status.name)) unregisteredActive += 1;
      }
      if (expectedMissing > 0) addObservation('CORTEXT_STATUS_AGENT_EXPECTED_MISSING');
      if (disabledActive > 0) addObservation('CORTEXT_STATUS_DISABLED_PROCESS_ACTIVE');
      if (unregisteredActive > 0) addObservation('CORTEXT_STATUS_UNREGISTERED_PROCESS_ACTIVE');
    }
  } else if (probe.kind === 'absent') {
    daemonStatus = 'stopped';
    ipcStatus = 'absent';
  } else if (probe.kind === 'refused') {
    daemonStatus = 'stopped';
    ipcStatus = 'refused';
    addObservation('CORTEXT_STATUS_DAEMON_ENDPOINT_STALE');
  } else if (probe.kind === 'timeout') {
    daemonStatus = 'unresponsive';
    ipcStatus = 'timeout';
    addObservation('CORTEXT_STATUS_DAEMON_TIMEOUT', true);
  } else if (probe.kind === 'invalid') {
    daemonStatus = 'unresponsive';
    ipcStatus = 'invalid';
    addObservation('CORTEXT_STATUS_DAEMON_RESPONSE_INVALID', true);
  } else {
    daemonStatus = 'unknown';
    ipcStatus = 'unknown';
    addObservation('CORTEXT_STATUS_DAEMON_STATUS_UNKNOWN', true);
  }

  const materialObservation = [...observationCodes].some(code => {
    const severity = OBSERVATIONS[code]?.severity;
    return severity === 'warning' || severity === 'error' || severity === 'critical';
  });
  let overallStatus: OverallStatus;
  if (!stateReadable || inventory.collision || customRootUnbound) overallStatus = 'blocked';
  else if (daemonStatus === 'unknown') overallStatus = 'unknown';
  else if (daemonStatus === 'stopped') overallStatus = 'stopped';
  else if (daemonStatus === 'unresponsive' || materialObservation || partial) overallStatus = 'degraded';
  else overallStatus = 'healthy';

  const observations = observationList(observationCodes);
  const collectionCompleted = options.now ?? new Date();

  return {
    schema_version: 'cortext.status/v1',
    ok: true,
    observed_at: collectionStarted.toISOString(),
    snapshot_status: partial ? 'partial' : 'complete',
    scope: {
      requested_instance: requestedInstance,
      selection_source: selectionSource,
      resolved_instance_id: instanceId,
      target_kind: 'live',
      layout_kind: frameworkRoot ? 'legacy_combined' : 'unknown',
    },
    manager: {
      version: CORTEXTOS_VERSION,
      protocol_version: null,
      status_contract: 'cortext.status/v1',
      installation_status: 'legacy_bridge',
      integrity: 'unverified',
      trust_status: 'unsupported',
      recovery_launcher_status: 'unsupported',
    },
    capabilities: {
      profile: 'legacy_bridge_v1',
      supported: [
        'legacy_layout',
        'legacy_application_evidence',
        'legacy_state_readability',
        'legacy_agent_inventory',
        'legacy_daemon_ipc',
        'redacted_projection',
        'check_policies_v1',
      ],
      unsupported: [
        'transaction_basis',
        'device_identity',
        'writer_lease',
        'release_integrity',
        'component_lock',
        'recovery_index',
        'update_metadata',
        'compatibility_matrix',
      ],
    },
    basis: {
      instance_id: instanceId,
      manager_version: CORTEXTOS_VERSION,
      trust_metadata_revision: null,
      compatibility_matrix_revision: null,
      lifecycle_generation: null,
      writer_epoch: null,
      selected_release_id: null,
      config_revision: null,
      observation_manifest_version: null,
      config_observation_digest: null,
      state_schema: null,
      state_layout_generation: null,
      state_control_observation_digest: null,
      component_lock_revision: null,
    },
    consistency: {
      collection_started_at: collectionStarted.toISOString(),
      collection_completed_at: collectionCompleted.toISOString(),
      generation_before: null,
      generation_after: null,
      status: 'unsupported',
    },
    device: {
      identity_status: 'absent', device_id: null, writer_role: 'unknown',
      lease_status: 'unsupported', lease_expires_at: null,
    },
    application: {
      version: applicationVersion,
      release_id: null,
      source_commit: sourceCommit,
      channel: null,
      integrity: 'unverified',
      selection: 'unknown',
      root: options.includePaths ? frameworkRoot : null,
      version_evidence: versionEvidence,
    },
    instance: {
      instance_id: instanceId,
      display_name: null,
      config_schema: null,
      config_revision: null,
      config_status: 'unknown',
      versioning: frameworkRoot ? (gitBacked ? 'git' : 'unversioned') : 'unknown',
      remote_status: remoteStatus,
      portability: 'unknown',
      root: options.includePaths ? frameworkRoot : null,
    },
    state: {
      schema_version: null,
      status: stateStatus,
      migration_status: 'unknown',
      migration_id: null,
      root: options.includePaths ? ctxRoot : null,
    },
    components: {
      lock_status: 'unsupported', lock_revision: null, declared: null,
      resolved: null, drift: 'unknown',
    },
    runtime: {
      daemon: {
        status: daemonStatus, pid: null, started_at: null,
        application_release_id: null, ipc_status: ipcStatus,
      },
      dashboard: { status: 'unknown' },
      agents: {
        configured: inventory.configured,
        enabled: inventory.enabled,
        observed_processes: observedProcesses,
        active_processes: activeProcesses,
        running,
        starting,
        stopped,
        busy: null,
        degraded,
        unknown: inventory.collision ? null : unknownAgents,
        expected_missing: inventory.collision ? null : expectedMissing,
        disabled_active: inventory.collision ? null : disabledActive,
        unregistered_active: inventory.collision ? null : unregisteredActive,
        recent_heartbeat: inventory.recentHeartbeats,
        stale_heartbeat: inventory.staleHeartbeats,
      },
      pollers: { expected: null, active: null, duplicates: null },
      crons: { enabled: null, due: null, overdue: null, paused: null },
      isolation: {
        profile: 'legacy_full_host',
        boundary: 'none',
        data_roots: 'live',
        process_namespace: 'live',
        managed_integrations: 'unknown',
        credentials: 'unknown',
        network: 'unrestricted',
        host_access: 'full',
        claim: 'none',
        evidence_codes: [],
      },
    },
    recovery: {
      latest_checkpoint: { id: null, created_at: null, verification: 'unknown' },
      latest_state_backup: { id: null, created_at: null, verification: 'unknown' },
      rollback_release_id: null,
      rollback_status: 'unknown',
    },
    updates: {
      channel: null, policy: null, pinned_release: null,
      availability: 'not_checked', candidate_release_id: null, checked_at: null,
    },
    compatibility: { status: 'unknown', matrix_version: null, reasons: [] },
    overall: {
      status: overallStatus,
      summary: overallSummary(overallStatus),
      highest_severity: highestSeverity(observations),
    },
    check: null,
    observations,
  };
}
