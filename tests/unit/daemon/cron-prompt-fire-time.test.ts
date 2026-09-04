import { describe, expect, it } from 'vitest';
import { resolveCronPrompt } from '../../../src/daemon/agent-manager.js';

/**
 * The write path (`bus/crons.ts` -> `validateCronPrompt`) refuses to STORE an
 * empty cron prompt. Nothing guarded FIRE TIME, so every empty prompt already on
 * disk kept firing empty: `cron.prompt ?? fallback` passes `''` through, because
 * `??` only falls back on null/undefined.
 *
 * A cron that fires exactly on time and injects nothing is the at-rest/failed
 * ambiguity this repo keeps producing: `last_fire` advances, `fire_count`
 * increments, the dashboard is green, and no work happens.
 */
describe('resolveCronPrompt: the fallback is decided at fire time, not at write time', () => {
  it('uses a real prompt', () => {
    expect(resolveCronPrompt({ name: 'heartbeat', prompt: 'Read HEARTBEAT.md' })).toBe(
      'Read HEARTBEAT.md',
    );
  });

  // The two arms the shipped `??` got wrong.
  it('falls back on an EMPTY STRING — the case `??` passes through', () => {
    expect(resolveCronPrompt({ name: 'lane-watch', prompt: '' })).toBe('[cron] lane-watch fired');
  });

  it('falls back on WHITESPACE ONLY — the case a bare `||` would still pass through', () => {
    expect(resolveCronPrompt({ name: 'lane-watch', prompt: '   \n\t ' })).toBe(
      '[cron] lane-watch fired',
    );
  });

  it('falls back on undefined and on a non-string', () => {
    expect(resolveCronPrompt({ name: 'nightly' })).toBe('[cron] nightly fired');
    expect(resolveCronPrompt({ name: 'nightly', prompt: undefined })).toBe('[cron] nightly fired');
    expect(resolveCronPrompt({ name: 'nightly', prompt: 42 as unknown as string })).toBe(
      '[cron] nightly fired',
    );
  });

  /**
   * THE MUST-STAY-GREEN ARM, and it is what makes the rest mean anything.
   * A helper that returned the fallback unconditionally would satisfy every
   * assertion above. These two say a REAL value still wins — including strings
   * that are falsy-looking but legitimate.
   */
  it('a real prompt still wins, including falsy-LOOKING ones', () => {
    expect(resolveCronPrompt({ name: 'x', prompt: '0' })).toBe('0');
    expect(resolveCronPrompt({ name: 'x', prompt: 'false' })).toBe('false');
    expect(resolveCronPrompt({ name: 'x', prompt: ' padded ' })).toBe(' padded ');
  });

  it('the fallback names the cron, so an empty-prompt fire is identifiable in the log', () => {
    expect(resolveCronPrompt({ name: 'kb-snapshot', prompt: '' })).toContain('kb-snapshot');
  });
});
