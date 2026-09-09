/**
 * tests/unit/dashboard/display-field.test.ts
 *
 * Regression coverage for `displayField` in dashboard/src/lib/utils.ts.
 *
 * WHY THIS FILE EXISTS. The helper was written, its import and all five call
 * sites were committed, and the helper itself was not — it sat in an
 * uncommitted working file, was swept into a park-the-working-tree commit on a
 * branch that never reached main, and Dashboard Build failed TS2305 on every
 * run until it was restored. It had NO behavioural coverage in the repo at any
 * point, before or after. The only test of it was a reviewer's throwaway
 * harness, which is a rule with no repo home: the next person to touch this
 * function would have had to re-derive those cases, and a second, subtly
 * different harness is how the coverage quietly changes.
 *
 * The 22 vectors below are ported VERBATIM from that review harness rather
 * than re-invented, for exactly that reason.
 *
 * ⛔ THE MUTATION TESTS ARE THE POINT, NOT THE VECTORS. Passing 22 cases only
 * says the function works today. The mutants say WHICH PARTS ARE LOAD-BEARING,
 * and they are what stops a future "tidy-up" from passing tsc while silently
 * dropping a property — tsc only requires the export to exist, not to behave.
 *
 * ⚠ AND THEY RECORD A MEASURED CORRECTION. The source comment used to claim
 * that splitting before the comment test made a bare placeholder "stop being
 * detectable". That is FALSE and was measured false: the `<!` prefix guard
 * still catches the torn marker. The split-first mutant breaks four OTHER
 * cases — embedded, multiple and multiline comments, and legitimate hyphenated
 * text. The ordering is load-bearing; the stated mechanism was not.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const utilsPath = resolve(repoRoot, 'dashboard/src/lib/utils.ts');
const dashboardRequire = createRequire(resolve(repoRoot, 'dashboard/package.json'));

type DisplayField = (raw: string | null | undefined, fallback: string) => string;

/** Compile the REAL source file (optionally mutated) and hand back displayField. */
function loadDisplayField(source: string): DisplayField {
  const ts = dashboardRequire('typescript');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  runInNewContext(js, { exports, require: dashboardRequire, console, process });
  return exports.displayField as DisplayField;
}

const source = readFileSync(utilsPath, 'utf8');

/** Ported verbatim from the PR review harness. [name, input, expected] with fallback 'slug'. */
const VECTORS: Array<[string, string | null | undefined, string]> = [
  ['undefined', undefined, 'slug'],
  ['null', null, 'slug'],
  ['empty', '', 'slug'],
  ['spaces', ' \n ', 'slug'],
  ['bare comment', '<!-- Agent name -->', 'slug'],
  ['leading spaces comment', '  <!-- Role -->  ', 'slug'],
  ['partial comment', '<!-- unfinished', 'slug'],
  ['partial declaration', '<! unfinished', 'slug'],
  ['embedded', 'Growth <!-- private hint --> lead', 'Growth  lead'],
  ['multiple', 'A<!-- one -->B<!-- two -->C', 'ABC'],
  ['multiline', 'A<!-- one\ntwo -->B', 'AB'],
  ['tbd', 'TbD', 'slug'],
  ['todo', 'todo', 'slug'],
  ['xxx', 'XXXX', 'slug'],
  ['placeholder', 'placeholder', 'slug'],
  ['onboarding', 'set during onboarding', 'slug'],
  ['na', 'n/a', 'slug'],
  ['none', 'None', 'slug'],
  ['trim', '  Real role  ', 'Real role'],
  ['hyphens', 'Growth - long-term systems', 'Growth - long-term systems'],
  ['emoji', '🛡️', '🛡️'],
  ['normal', 'Research and QA', 'Research and QA'],
];

function failuresUnder(mutatedSource: string): string[] {
  const fn = loadDisplayField(mutatedSource);
  return VECTORS.filter(([, input, want]) => fn(input, 'slug') !== want).map(([name]) => name);
}

describe('displayField', () => {
  const displayField = loadDisplayField(source);

  it.each(VECTORS)('%s', (_name, input, want) => {
    expect(displayField(input, 'slug')).toBe(want);
  });

  it('is exported from @/lib/utils (the import that was red on main for days)', () => {
    expect(typeof displayField).toBe('function');
  });
});

describe('displayField — which parts are load-bearing', () => {
  it('ordering: testing the ORIGINAL string before splitting is required', () => {
    const mutated = source.replace(
      'const original = raw.trim();',
      "const original = raw.split('-')[0].trim();",
    );
    expect(mutated).not.toBe(source); // the mutation must actually apply
    const failures = failuresUnder(mutated);

    // MEASURED, and it corrects the source comment's original claim:
    // a BARE comment is still caught, because the `<!` prefix guard sees the torn marker.
    expect(failures).not.toContain('bare comment');
    // What actually breaks:
    expect(failures).toEqual(
      expect.arrayContaining(['embedded', 'multiple', 'multiline', 'hyphens']),
    );
    expect(failures).toHaveLength(4);
  });

  it('the `<!` prefix guard is required for partial/torn markers', () => {
    const mutated = source.replace(
      "if (original.startsWith('<!--') || original.startsWith('<!')) return fallback;",
      '',
    );
    expect(mutated).not.toBe(source);
    const failures = failuresUnder(mutated);
    expect(failures).toEqual(
      expect.arrayContaining(['partial comment', 'partial declaration']),
    );
    expect(failures).toHaveLength(2);
  });
});
