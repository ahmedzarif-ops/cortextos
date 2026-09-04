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

/**
 * The two forms the duty takes, and they are NOT interchangeable.
 *
 * A non-orchestrator seat must state the prohibition unconditionally. The
 * orchestrator states the INVERSE — owner contact is its job. The original
 * assertion was `unconditional|owner contact is yours to make`, one alternation
 * over both templates, which means an ANALYST template that said "owner contact
 * is yours to make" would have passed the guard. The inversion has to be
 * asserted AS an inversion and pinned to the seat entitled to it, or it is just
 * a second way for every other seat to pass.
 */
const UNCONDITIONAL_DUTY = /unconditional/i;
const INVERTED_DUTY = /owner contact is yours to make/i;

/** The one template directory entitled to the inverted duty. */
const INVERTED_TEMPLATE = 'orchestrator';

/**
 * ⛔ `\Z` IS NOT A JAVASCRIPT ANCHOR. It is an identity escape — a literal `Z`.
 * Verified on this runtime: `/a\Z/.test('a')` is FALSE, `/a\Z/.test('aZ')` is TRUE.
 *
 * This pattern used to end `(?=^##\s|\Z)`, so the intended "…or end of input"
 * alternative did not exist: the lookahead could only ever succeed on a
 * following `^## ` heading, or on a stray capital Z. Found by guard reviewing
 * this file at c31146f and reproduced by moving the lifecycle section to the END
 * of templates/analyst/SOUL.md — the extractor returned null and the suite
 * reported "has no Lifecycle communication section" over a section plainly there.
 *
 * Not live today only because all six SOUL.md happen to place `## Communication`
 * after the lifecycle section. That ordering is a property of the current
 * templates, not of the guard — one template edit or onboarding write changes it.
 *
 * The JS end-of-input form is `$(?![\s\S])`: `$` under /m matches at every line
 * end, and the negative lookahead keeps only the one with nothing after it.
 *
 * ⚠ FAILURE DIRECTION: this defect failed NOISY (false alarm), not clean, which
 * is the safe half. It is still worth fixing because the message it produces
 * sends a reader hunting for a section that is present.
 */
const LIFECYCLE_SECTION = /^##\s+Lifecycle communication[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m;

/** Returns the lifecycle section BODY, or null when the section is absent. */
function lifecycleSection(body: string): string | null {
  const m = body.match(LIFECYCLE_SECTION);
  return m === null ? null : (m[1] ?? '');
}

/**
 * The extractor and the needles are tested on FIXTURES, not on the templates.
 *
 * Every assertion in the suite below is only as good as these three objects. A
 * template-only suite cannot see a dead pattern or a positional extractor bug:
 * it reports clean while guarding nothing, because the templates currently
 * happen to be arranged in the one way that hides the defect. That is precisely
 * how the `\Z` bug and the non-unique-needle bug both survived review.
 */
describe("the guard's own instruments", () => {
  describe('lifecycleSection()', () => {
    const BODY = '**The rule is unconditional for a non-orchestrator seat.**\n';

    it('finds the section when ANOTHER heading follows it', () => {
      const doc = `# Soul\n\n## Lifecycle communication — ONE VOICE\n\n${BODY}\n## Communication\n- terse\n`;
      expect(lifecycleSection(doc)).toMatch(UNCONDITIONAL_DUTY);
      // Must stop at the next heading, not swallow the rest of the file.
      expect(lifecycleSection(doc)).not.toMatch(/terse/);
    });

    it('finds the section when it is LAST IN THE FILE — the \\Z regression', () => {
      // ⛔ THIS IS THE CASE THE OLD PATTERN GOT WRONG. With `\Z` (a literal Z)
      // the lookahead had no end-of-input alternative, so a trailing section
      // matched nothing and the suite reported the section MISSING.
      const doc = `# Soul\n\n## Communication\n- terse\n\n## Lifecycle communication — ONE VOICE\n\n${BODY}`;
      expect(lifecycleSection(doc)).toMatch(UNCONDITIONAL_DUTY);
    });

    it('finds the section when it is last AND the file has no trailing newline', () => {
      const doc = `## Lifecycle communication — ONE VOICE\n${BODY.trimEnd()}`;
      expect(lifecycleSection(doc)).toMatch(UNCONDITIONAL_DUTY);
    });

    it('returns null when the section is absent — the extractor can say NO', () => {
      // Without this, an extractor that returned '' for everything would pass
      // every "section is present" assertion in the suite.
      expect(lifecycleSection(`# Soul\n\n## Communication\n${BODY}`)).toBeNull();
    });

    it('returns an EMPTY body for a heading with nothing under it', () => {
      // Distinct from null on purpose: the suite asserts on the body, so a
      // hollowed-out section must reach the marker assertion and fail THERE.
      expect(lifecycleSection('## Lifecycle communication — ONE VOICE\n')).toBe('');
    });
  });

  it('positive control: every CONDITIONAL_PROHIBITION pattern can actually match', () => {
    // A negative assertion repeated over six templates is worth nothing if the
    // pattern is dead. A typo in any one of these would guard NOTHING, fleet-wide,
    // and every template would still report clean.
    const specimens = [
      'No Telegram to the owner unless it is genuinely critical.',
      'Do not send Telegram messages unless severity is critical.',
      "Don't send Telegram to the owner unless the system is down.",
      'Telegram messages unless severity = critical are forbidden.',
    ];
    for (const pattern of CONDITIONAL_PROHIBITION) {
      expect(
        specimens.some((s) => pattern.test(s)),
        `CONDITIONAL_PROHIBITION pattern matches no specimen — it is a dead needle: ${pattern}`,
      ).toBe(true);
    }
    // And it must be able to say NO, or it would fail on every template forever.
    for (const pattern of CONDITIONAL_PROHIBITION) {
      expect(pattern.test('Route all owner traffic to the configured orchestrator.')).toBe(false);
    }
  });

  it('positive control: ROUTING_MARKER matches the rule and rejects unrelated prose', () => {
    expect(ROUTING_MARKER.test('routes to the configured orchestrator')).toBe(true);
    expect(ROUTING_MARKER.test('## Lifecycle communication — ONE VOICE')).toBe(true);
    expect(ROUTING_MARKER.test('Idle is failure. Work through the task list.')).toBe(false);
  });

  it('positive control: the two duty forms are DISJOINT', () => {
    // If these overlapped, pinning the inverted form to one template would be
    // decoration — every seat would satisfy both branches.
    expect(UNCONDITIONAL_DUTY.test('owner contact is yours to make')).toBe(false);
    expect(INVERTED_DUTY.test('The rule is unconditional for a non-orchestrator seat')).toBe(false);
  });
});

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

    it('SOUL.md states the lifecycle routing rule IN ITS OWN SECTION', () => {
      const body = read(`${dir}/SOUL.md`);
      if (body === null) return;
      // ⛔ THIS ASSERTION USED TO BE `expect(body).toMatch(ROUTING_MARKER)` AND A MUTANT SURVIVED IT.
      // Measured 2026-09-04 (sentinel): deleting the ENTIRE
      // `## Lifecycle communication — ONE VOICE` section from templates/analyst/SOUL.md left this
      // suite at 26/26 GREEN. The marker still matched — on an unrelated line in the Day/Night Mode
      // section: "No owner-initiated Telegram at all — route anything urgent to the configured
      // orchestrator instead."
      // ⇒ A PRESENCE CHECK WHOSE NEEDLE IS NOT UNIQUE TO THE THING IT GUARDS CANNOT SEE THAT THING
      // REMOVED. It reported clean over a template that had lost the rule entirely — one
      // `/onboarding` away from restoring a live seat with no countermand, which is the exact
      // failure this file's header says it exists to prevent.
      // ⚠ AND THE SENTENCE THAT KEPT IT GREEN IS ITSELF SCOPED TO NIGHT MODE — a conditional
      // statement of the rule, the defect class named at the top of this file. The
      // CONDITIONAL_PROHIBITION patterns miss it because they look for "unless", not for a
      // section scope.
      // ⇒ Require the SECTION, then require the marker INSIDE it. Both, because a heading with an
      // empty body would satisfy the first alone.
      const section = lifecycleSection(body);
      expect(section, `${dir}/SOUL.md has no "## Lifecycle communication" section`).not.toBeNull();
      expect(section ?? '', `${dir}: the lifecycle section does not state the routing rule`)
        .toMatch(ROUTING_MARKER);

      // ⛔ THE DUTY IS ASSERTED PER SEAT, NOT AS AN ALTERNATION.
      // This used to be one `toMatch(/unconditional|owner contact is yours to make/i)` for every
      // template. That alternation is a hole: an ANALYST template that said "owner contact is
      // yours to make" — the exact sentence that licenses owner sends — would have passed the
      // guard whose entire purpose is to forbid it. The inverted form has to be pinned to the one
      // seat entitled to it, and forbidden on every other, or it is a second door for all six.
      if (dir === INVERTED_TEMPLATE) {
        expect(section ?? '', `${dir}: the orchestrator's INVERTED duty is not stated`)
          .toMatch(INVERTED_DUTY);
      } else {
        expect(section ?? '', `${dir}: the lifecycle section states no unconditional duty`)
          .toMatch(UNCONDITIONAL_DUTY);
        expect(
          section ?? '',
          `${dir}: a non-orchestrator template claims the orchestrator's owner-contact duty`,
        ).not.toMatch(INVERTED_DUTY);
      }
    });

    it('AGENTS.md puts the routing banner ABOVE the first lifecycle owner-send', () => {
      const body = read(`${dir}/AGENTS.md`);
      if (body === null) return;
      const send = body.search(/send-telegram \$CTX_TELEGRAM_CHAT_ID/);
      if (send === -1) return;
      // ⛔ THIS USED TO BE `expect(body).toMatch(ROUTING_MARKER)` — a whole-file presence check,
      // the SAME non-unique-needle class as the SOUL.md bug this file was rescued to fix, one
      // assertion over. Measured 2026-09-04: ROUTING_MARKER matches TWO lines in each AGENTS.md,
      // so the assertion could be satisfied by prose that is not the countermand at all — and it
      // said nothing about POSITION, which is the only property that makes the countermand work.
      // The file states the requirement in its own words: "This banner sits above step 1 on
      // purpose... a countermand that lives only in SOUL.md is one a cold agent meets only after
      // the action — which is not a rule it can obey." Assert the stated requirement.
      const banner = body.search(/^>?\s*##\s+ONE VOICE\b/m);
      expect(banner, `${dir}/AGENTS.md has a lifecycle send and no "## ONE VOICE" banner`)
        .toBeGreaterThan(-1);
      expect(banner, `${dir}/AGENTS.md: the ONE VOICE banner sits BELOW the first lifecycle send`)
        .toBeLessThan(send);
    });
  });

  it('the inverted duty belongs to EXACTLY ONE template, and it is the orchestrator', () => {
    // Cardinality control for the per-template branch above. Two failure modes it closes:
    //   (a) a second template acquires "owner contact is yours to make" and is never checked for
    //       the unconditional form;
    //   (b) templates/orchestrator/SOUL.md disappears or is renamed, and the INVERTED branch is
    //       never taken at all — the pin becomes vacuous and nothing announces it.
    const carriers = templateDirs()
      .map((d) => ({ dir: d, body: read(`${d}/SOUL.md`) }))
      .filter((x): x is { dir: string; body: string } => x.body !== null)
      .filter((x) => INVERTED_DUTY.test(lifecycleSection(x.body) ?? ''))
      .map((x) => x.dir);
    expect(carriers).toEqual([INVERTED_TEMPLATE]);
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
