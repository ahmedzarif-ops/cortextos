import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the template layer.
 *
 * Why this exists: seat files are patched by hand and `templates/` is not. A
 * whole-file onboarding write regenerates a seat from these templates, so a
 * defect that survives here is one `/onboarding` away from being restored on a
 * live seat — while reporting success. Measured 2026-09-03 before this guard:
 * ZERO of six templates carried any routing countermand.
 *
 * SCOPE, deliberately narrow. `templates/` also seeds SINGLE-AGENT deployments
 * that are not part of this fleet, where an agent messaging its own user is
 * CORRECT. So this guard does NOT ban owner-sends. It requires that the
 * lifecycle rule be stated in the deployment-neutral form the daemon actually
 * enforces: authority comes from the configured orchestrator in
 * orgs/<org>/context.json, and a deployment with no such file is unaffected.
 */

const TEMPLATES = resolve(__dirname, '../../templates');

function templateDirs(): string[] {
  return readdirSync(TEMPLATES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function read(rel: string): string | null {
  const p = join(TEMPLATES, rel);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

/**
 * The defect class, stated as a shape rather than a string.
 *
 * A CONDITIONAL prohibition licenses sending twice by omission: once through
 * the exception clause, and once by implying the ban is scoped to the named
 * condition. Neither escape contains an imperative, so a `send-telegram` grep
 * cannot see it — which is exactly how the live instance survived three sweeps.
 */
const CONDITIONAL_PROHIBITION = [
  /no telegram[^.\n]*\bunless\b/i,
  /do not send telegram[^.\n]*\bunless\b/i,
  /don't send telegram[^.\n]*\bunless\b/i,
  /telegram messages?[^.\n]*\bunless (?:severity|it is )?\s*=?\s*critical/i,
];

/** Deployment-neutral marker: names the authority, not our org's hierarchy. */
const ROUTING_MARKER = /ONE VOICE|configured orchestrator/i;

describe('template regression guard: ONE VOICE survives a fresh onboarding', () => {
  it('positive control: the template tree is actually being read', () => {
    const dirs = templateDirs();
    expect(dirs.length).toBeGreaterThan(0);
    // If this ever passes with zero SOUL.md files, every assertion below is
    // vacuous and would report clean over an empty set.
    const souls = dirs.map((d) => read(`${d}/SOUL.md`)).filter(Boolean);
    expect(souls.length).toBeGreaterThan(0);
  });

  describe.each(templateDirs())('templates/%s', (dir) => {
    it('SOUL.md carries no conditional owner-send prohibition', () => {
      const body = read(`${dir}/SOUL.md`);
      if (body === null) return; // not every template ships a SOUL.md
      for (const pattern of CONDITIONAL_PROHIBITION) {
        expect(body, `conditional prohibition matched ${pattern}`).not.toMatch(pattern);
      }
    });

    it('SOUL.md states the lifecycle routing rule', () => {
      const body = read(`${dir}/SOUL.md`);
      if (body === null) return;
      expect(body).toMatch(ROUTING_MARKER);
    });

    it('AGENTS.md pairs any lifecycle owner-send with the routing rule', () => {
      const body = read(`${dir}/AGENTS.md`);
      if (body === null) return;
      const hasLifecycleSend = /send-telegram \$CTX_TELEGRAM_CHAT_ID/.test(body);
      if (!hasLifecycleSend) return;
      // The countermand must travel in the same file as the instruction: a rule
      // a cold agent meets only after the action is not a rule it can obey.
      expect(body).toMatch(ROUTING_MARKER);
    });
  });

  it('the Step-7b whole-file SOUL.md write preserves the sections holding the rule', () => {
    // The write that regenerates SOUL.md must name Communication and Day/Night
    // Mode among its preserved sections, or it silently deletes the countermand
    // and the closed exception list and reports success.
    const onboardings = templateDirs()
      .map((d) => ({ dir: d, body: read(`${d}/ONBOARDING.md`) }))
      .filter((x): x is { dir: string; body: string } => x.body !== null)
      .filter((x) => /SOUL\.md/.test(x.body));

    expect(onboardings.length, 'no ONBOARDING.md references SOUL.md — check the fixture')
      .toBeGreaterThan(0);

    for (const { dir, body } of onboardings) {
      // Assert on the PRESERVE INSTRUCTION, not on the bare strings. "Day/Night
      // Mode" occurs in these files for unrelated reasons (placeholder
      // substitution steps), so a presence check would pass without the
      // preserve list ever naming it — clean output over an unfixed file.
      const preserveClause = body.match(
        /(?:Do NOT delete[^\n]*|Section-level writes only[^\n]*(?:\n>[^\n]*)*)/g,
      );
      expect(preserveClause, `${dir}/ONBOARDING.md has no preserve instruction at all`)
        .not.toBeNull();
      const clause = (preserveClause ?? []).join('\n');
      expect(clause, `${dir}: preserve instruction omits Communication`)
        .toMatch(/Communication/);
      expect(clause, `${dir}: preserve instruction omits Day/Night Mode`)
        .toMatch(/Day\/Night Mode/);
    }
  });
});
