import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import type { AgentConfig } from '../types/index.js';
import { resolveHermesProfile, validateModel } from './validate.js';

const HERMES_REASONING_LEVELS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);
const HERMES_PROVIDER_PATTERN = /^[a-zA-Z0-9._-]+$/;

export type HermesLaunchPins = {
  profile: string;
  model: string;
  provider: string;
  reasoning: string;
};

/** Resolve and validate every routing pin required before a Hermes spawn. */
export function resolveHermesLaunchPins(config: AgentConfig, agentName: string): HermesLaunchPins {
  const profile = resolveHermesProfile(config.hermes_profile, agentName);
  const model = typeof config.model === 'string' ? config.model.trim() : '';
  const provider = typeof config.hermes_provider === 'string' ? config.hermes_provider.trim() : '';
  const reasoning = typeof config.hermes_reasoning === 'string' ? config.hermes_reasoning.trim() : '';

  if (!model) throw new Error('Hermes runtime requires an explicit fixed model pin');
  validateModel(model);
  if (!provider || !HERMES_PROVIDER_PATTERN.test(provider)) {
    throw new Error('Hermes runtime requires a non-empty provider pin containing only letters, numbers, dots, underscores, or hyphens');
  }
  if (!HERMES_REASONING_LEVELS.has(reasoning)) {
    throw new Error(`Hermes runtime requires a valid reasoning pin; got "${reasoning || '(missing)'}"`);
  }
  return { profile, model, provider, reasoning };
}

/** Resolve the isolated Hermes home for a standing-agent profile. */
export function hermesProfileHome(profile: string | undefined, hermesRoot?: string, fallbackAgentName = ''): string {
  const validProfile = resolveHermesProfile(profile, fallbackAgentName);
  const candidateRoot = hermesRoot || join(homedir(), '.hermes');
  const normalizedRoot = basename(dirname(candidateRoot)) === 'profiles'
    ? dirname(dirname(candidateRoot))
    : candidateRoot;
  return join(normalizedRoot, 'profiles', validProfile);
}

export function hermesDbExists(profile: string | undefined, hermesRoot?: string, fallbackAgentName = ''): boolean {
  return existsSync(join(hermesProfileHome(profile, hermesRoot, fallbackAgentName), 'state.db'));
}

/** Fail before spawn when Hermes hidden profile parsing would exit immediately. */
export function assertHermesProfileExists(profile: string, hermesRoot?: string): void {
  const profileHome = hermesProfileHome(profile, hermesRoot);
  if (!existsSync(profileHome)) {
    throw new Error(
      `Hermes profile "${profile}" does not exist at ${profileHome}. ` +
      `Create it before starting this seat: hermes profile create ${profile} --clone --no-alias`,
    );
  }
}

/**
 * Refuse cortextOS cron ownership if the same Hermes profile has any enabled
 * native jobs. Invalid native state is failure-shaped because silence cannot
 * prove that double scheduling is absent.
 */
export function assertNoHermesNativeCronCollision(
  profile: string | undefined,
  agentName: string,
  hermesRoot?: string,
): void {
  const resolvedProfile = resolveHermesProfile(profile, agentName);
  const jobsPath = join(hermesProfileHome(resolvedProfile, hermesRoot), 'cron', 'jobs.json');
  if (!existsSync(jobsPath)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(jobsPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`Cannot prove cron ownership for Hermes profile "${resolvedProfile}": ${jobsPath} is unreadable or invalid (${err})`);
  }
  const jobs = (parsed as { jobs?: unknown })?.jobs;
  if (!Array.isArray(jobs)) {
    throw new Error(`Cannot prove cron ownership for Hermes profile "${resolvedProfile}": ${jobsPath} has no jobs array`);
  }
  const enabled = jobs.filter((job) => {
    if (!job || typeof job !== 'object') return true;
    const candidate = job as { enabled?: unknown; state?: unknown };
    return candidate.enabled !== false && candidate.state !== 'paused';
  });
  if (enabled.length > 0) {
    throw new Error(
      `Cron ownership collision for Hermes profile "${resolvedProfile}": ` +
      `${enabled.length} enabled native job(s) in ${jobsPath}; cortextOS scheduler not started`,
    );
  }
}
