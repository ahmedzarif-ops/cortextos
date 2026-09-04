/**
 * resolveModeSettings — where the timezone and day window actually come from.
 *
 * This is the half that made the bug FLEET-WIDE rather than local. detectDayNightMode was always
 * capable of the right answer; nothing ever handed it the org's settings, so `update-heartbeat`
 * with no flag computed in UTC. The config was not missing — it was never consulted, which looks
 * identical from outside and is why it survived.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveModeSettings, buildHeartbeatOptions } from '../../../src/cli/bus';

let root: string;
const ORG = 'test-org';
const AGENT = 'test-agent';

function writeAgentConfig(obj: Record<string, unknown>) {
  const dir = join(root, 'orgs', ORG, 'agents', AGENT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(obj));
}

function writeOrgContext(obj: Record<string, unknown>) {
  const dir = join(root, 'orgs', ORG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'context.json'), JSON.stringify(obj));
}

describe('resolveModeSettings', () => {
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hbmode-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('THE REGRESSION: with only org context present it returns the org timezone, not UTC', () => {
    writeOrgContext({ timezone: 'America/Chicago', day_mode_start: '08:00', day_mode_end: '00:00' });
    const r = resolveModeSettings(root, ORG, AGENT);
    expect(r.timezone).toBe('America/Chicago');
    expect(r.dayModeStart).toBe('08:00');
    expect(r.dayModeEnd).toBe('00:00');
  });

  it('agent config OVERRIDES org context', () => {
    writeOrgContext({ timezone: 'America/Chicago', day_mode_start: '08:00', day_mode_end: '00:00' });
    writeAgentConfig({ timezone: 'Asia/Tokyo', day_mode_start: '09:00', day_mode_end: '18:00' });
    const r = resolveModeSettings(root, ORG, AGENT);
    expect(r).toEqual({ timezone: 'Asia/Tokyo', dayModeStart: '09:00', dayModeEnd: '18:00' });
  });

  it('the override is FIELD BY FIELD, not all-or-nothing', () => {
    // A seat may legitimately keep different hours from its org without restating the timezone.
    // Resolving these as one block would silently drop the org timezone the moment a seat set an
    // hour — a config that looks more specific and is less correct.
    writeOrgContext({ timezone: 'America/Chicago', day_mode_start: '08:00', day_mode_end: '00:00' });
    writeAgentConfig({ day_mode_start: '06:00' });
    const r = resolveModeSettings(root, ORG, AGENT);
    expect(r.timezone).toBe('America/Chicago'); // inherited
    expect(r.dayModeStart).toBe('06:00');       // overridden
    expect(r.dayModeEnd).toBe('00:00');         // inherited
  });

  it('the explicit --timezone flag beats both', () => {
    writeOrgContext({ timezone: 'America/Chicago' });
    writeAgentConfig({ timezone: 'Asia/Tokyo' });
    expect(resolveModeSettings(root, ORG, AGENT, 'Europe/Paris').timezone).toBe('Europe/Paris');
  });

  it('an EMPTY-STRING config value does not win over a real one', () => {
    // "" is falsy-but-present. Treating it as a value would make a blank field beat the org's.
    writeOrgContext({ timezone: 'America/Chicago' });
    writeAgentConfig({ timezone: '   ' });
    expect(resolveModeSettings(root, ORG, AGENT).timezone).toBe('America/Chicago');
  });

  it('MALFORMED json is survivable — a heartbeat must still write', () => {
    // A heartbeat that fails to write makes the seat read DEAD, which is far worse than a wrong
    // mode. So every read here is best-effort by design, and that is asserted rather than assumed.
    mkdirSync(join(root, 'orgs', ORG, 'agents', AGENT), { recursive: true });
    writeFileSync(join(root, 'orgs', ORG, 'agents', AGENT, 'config.json'), '{not json');
    writeOrgContext({ timezone: 'America/Chicago' });
    expect(() => resolveModeSettings(root, ORG, AGENT)).not.toThrow();
    expect(resolveModeSettings(root, ORG, AGENT).timezone).toBe('America/Chicago');
  });

  it('NO config at all returns undefined — so detectDayNightMode applies its declared defaults', () => {
    const r = resolveModeSettings(root, ORG, AGENT);
    expect(r.timezone).toBeUndefined();
    expect(r.dayModeStart).toBeUndefined();
    expect(r.dayModeEnd).toBeUndefined();
  });

  it('an empty frameworkRoot reads nothing but still honours the flag', () => {
    expect(resolveModeSettings('', ORG, AGENT).timezone).toBeUndefined();
    expect(resolveModeSettings('', ORG, AGENT, 'Asia/Tokyo').timezone).toBe('Asia/Tokyo');
  });
});

describe('buildHeartbeatOptions — THE SEAM, and the only thing that catches the real regression', () => {
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hbmode-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('carries the ORG timezone through to updateHeartbeat when no flag is given', () => {
    // ⛔ THE MUTANT THIS EXISTS FOR. With detectDayNightMode and resolveModeSettings each tested
    // directly, restoring `timezone: opts.timezone` at the call site passed ALL 19 other tests.
    // Both ends covered, joint uncovered — and the joint was the fleet-wide bug.
    writeOrgContext({ timezone: 'America/Chicago', day_mode_start: '08:00', day_mode_end: '00:00' });
    const o = buildHeartbeatOptions(root, ORG, AGENT, {});
    expect(o.timezone).toBe('America/Chicago');
    expect(o.dayModeStart).toBe('08:00');
    expect(o.dayModeEnd).toBe('00:00');
  });

  it('does NOT drop the window even when a --timezone flag overrides the zone', () => {
    // A flag that silently discarded the configured hours would be a new version of the same bug.
    writeOrgContext({ timezone: 'America/Chicago', day_mode_start: '08:00', day_mode_end: '00:00' });
    const o = buildHeartbeatOptions(root, ORG, AGENT, { timezone: 'Asia/Tokyo' });
    expect(o.timezone).toBe('Asia/Tokyo');
    expect(o.dayModeStart).toBe('08:00');
    expect(o.dayModeEnd).toBe('00:00');
  });

  it('still passes through the unrelated fields it is responsible for', () => {
    writeOrgContext({ timezone: 'America/Chicago' });
    const o = buildHeartbeatOptions(root, ORG, AGENT, { task: 't', interval: '4h' }, 'Display');
    expect(o).toMatchObject({ org: ORG, currentTask: 't', loopInterval: '4h', displayName: 'Display' });
  });
});
