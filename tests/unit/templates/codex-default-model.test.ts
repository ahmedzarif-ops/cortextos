/**
 * Guard: no SHIPPED TEMPLATE may default a codex-app-server seat to a model that
 * is rejected on the account type this fleet actually uses.
 *
 * Why this test exists (sentinel, org knowledge #76, 2026-09-04): a seat scaffolded
 * from `templates/agent-codex/` came up "running" with crons, heartbeat and inbox all
 * intact, and returned HTTP 400 on EVERY turn — "not supported when using Codex with
 * a ChatGPT account". Nothing in `cortextos status`, `ps`, the cron list or
 * `heartbeat.json` showed it; the failure appeared only in stdout.log. The dead model
 * came from the template default, so every future codex seat inherited it.
 *
 * The failure mode this pins is therefore NOT "a wrong string in a config file" but
 * "a default that produces a seat which looks healthy and cannot complete a turn".
 * A unit test is the right instrument precisely because the runtime signals are not.
 *
 * SCOPE, stated so this test is not over-read: it asserts what the templates SHIP.
 * It does not and cannot prove a model is live — that needs one completed turn through
 * the real runtime with the configured model, which is sentinel's go-readiness bar,
 * not a unit test's. This guard catches the regression, not the outage.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', 'templates');

/**
 * Models known to be REJECTED by codex app-server on a ChatGPT-account login.
 * Add to this list only from an observed failure, and cite it.
 *   - gpt-5-codex: 400 on every turn (sentinel #76, 2026-09-04)
 */
const DEAD_ON_CHATGPT_ACCOUNT = ['gpt-5-codex'];

/** The model proven to complete a real turn on the seat path (2026-09-04). */
const PROVEN_MODEL = 'gpt-5.6-sol';

function isDeadOnChatGPTAccount(model: string | undefined): boolean {
  if (!model) return false;
  return DEAD_ON_CHATGPT_ACCOUNT.includes(model.trim());
}

function readTemplateConfig(template: string): Record<string, unknown> | null {
  const p = join(TEMPLATES_DIR, template, 'config.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

describe('codex template default model', () => {
  it('agent-codex scaffolds the model proven to complete a turn', () => {
    const cfg = readTemplateConfig('agent-codex');
    expect(cfg).not.toBeNull();
    expect(cfg!.runtime).toBe('codex-app-server');
    expect(cfg!.model).toBe(PROVEN_MODEL);
  });

  it('agent-codex does not ship a model that 400s on a ChatGPT account', () => {
    const cfg = readTemplateConfig('agent-codex');
    expect(isDeadOnChatGPTAccount(cfg!.model as string)).toBe(false);
  });

  /**
   * POSITIVE CONTROL. The assertion above is a `toBe(false)`, and a predicate that
   * returned false unconditionally — a typo'd list, a renamed constant — would satisfy
   * it while catching nothing. This proves the predicate discriminates.
   */
  it('POSITIVE CONTROL: the predicate flags the model that actually failed', () => {
    expect(isDeadOnChatGPTAccount('gpt-5-codex')).toBe(true);
    expect(isDeadOnChatGPTAccount(PROVEN_MODEL)).toBe(false);
  });

  /**
   * Generalises past the single file: a NEW codex template added later must not
   * reintroduce the dead default. Without this, the guard only covers the one path
   * that already bit us.
   */
  it('no shipped template defaults a codex-app-server seat to a dead model', () => {
    const offenders: string[] = [];
    let codexTemplatesSeen = 0;

    for (const entry of readdirSync(TEMPLATES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfg = readTemplateConfig(entry.name);
      if (!cfg || cfg.runtime !== 'codex-app-server') continue;
      codexTemplatesSeen++;
      if (isDeadOnChatGPTAccount(cfg.model as string)) {
        offenders.push(`${entry.name}: ${String(cfg.model)}`);
      }
    }

    // Guard the guard: if the scan matched nothing, an empty `offenders` would pass
    // while proving nothing — the same shape as a dead control read as a clean result.
    expect(codexTemplatesSeen).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
