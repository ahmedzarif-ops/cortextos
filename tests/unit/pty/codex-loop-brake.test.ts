import { describe, it, expect } from 'vitest';
import {
  LoopBrake,
  isSleepCommand,
  loopBrakeNote,
  resolveLoopBrakeMode,
  REPEAT_LIMIT,
  SLEEP_LIMIT,
  SLEEP_WINDOW_MS,
  INTERRUPT_AFTER,
} from '../../../src/pty/codex-loop-brake.js';

describe('isSleepCommand', () => {
  it.each([
    'sleep 30',
    'sleep 30; cortextos bus check-inbox',
    'while true; do x; sleep 60; done',
    'sleep 5m',
    'sleep $N',
    "/bin/zsh -lc 'sleep 30 && cortextos bus check-inbox'",
    'x && sleep 0.5',
    '(sleep 10)',
  ])('matches %s', (cmd) => {
    expect(isSleepCommand(cmd)).toBe(true);
  });

  it.each(['sleeper 3', 'npx foo --sleep 3', 'echo asleep', 'ls sleep/'])('ignores %s', (cmd) => {
    expect(isSleepCommand(cmd)).toBe(false);
  });
});

describe('resolveLoopBrakeMode', () => {
  it('defaults to shadow and accepts off/on', () => {
    expect(resolveLoopBrakeMode(undefined)).toBe('shadow');
    expect(resolveLoopBrakeMode('bogus')).toBe('shadow');
    expect(resolveLoopBrakeMode('off')).toBe('off');
    expect(resolveLoopBrakeMode('on')).toBe('on');
  });
});

describe('LoopBrake repeat detection', () => {
  it('steers on the REPEAT_LIMIT-th identical command in a row, not before', () => {
    const brake = new LoopBrake();
    for (let i = 1; i < REPEAT_LIMIT; i++) {
      expect(brake.observe('cortextos bus check-inbox', i).action).toBe('none');
    }
    expect(brake.observe('cortextos bus check-inbox', REPEAT_LIMIT)).toEqual({ action: 'steer', kind: 'repeat', count: REPEAT_LIMIT });
  });

  it('treats whitespace-only differences as the same command', () => {
    const brake = new LoopBrake();
    for (let i = 1; i < REPEAT_LIMIT; i++) brake.observe('git  status ', i);
    expect(brake.observe('git status', REPEAT_LIMIT).action).toBe('steer');
  });

  it('a different command in between resets the run', () => {
    const brake = new LoopBrake();
    for (let i = 1; i < REPEAT_LIMIT; i++) brake.observe('git status', i);
    brake.observe('ls', 10);
    expect(brake.observe('git status', 11).action).toBe('none');
  });

  it('a new turn resets the run (one check per heartbeat turn is not a loop)', () => {
    const brake = new LoopBrake();
    for (let i = 1; i < REPEAT_LIMIT; i++) brake.observe('cortextos bus check-inbox', i);
    brake.startTurn();
    expect(brake.observe('cortextos bus check-inbox', 100).action).toBe('none');
  });

  it('interrupts after INTERRUPT_AFTER further hits once steered, then starts clean', () => {
    const brake = new LoopBrake();
    for (let i = 1; i <= REPEAT_LIMIT; i++) brake.observe('x', i);
    for (let i = 1; i < INTERRUPT_AFTER; i++) {
      expect(brake.observe('x', 100 + i).action).toBe('none');
    }
    expect(brake.observe('x', 200).action).toBe('interrupt');
    expect(brake.observe('x', 201).action).toBe('none');
  });
});

describe('LoopBrake sleep detection', () => {
  it('steers on the SLEEP_LIMIT-th sleep call inside the window, across turns', () => {
    const brake = new LoopBrake();
    for (let i = 1; i < SLEEP_LIMIT; i++) {
      brake.startTurn();
      expect(brake.observe(`sleep ${i}; cortextos bus check-inbox`, i * 1000).action).toBe('none');
    }
    brake.startTurn();
    expect(brake.observe('sleep 99', SLEEP_LIMIT * 1000)).toEqual({ action: 'steer', kind: 'sleep', count: SLEEP_LIMIT });
  });

  it('forgets sleeps older than the window', () => {
    const brake = new LoopBrake();
    for (let i = 1; i < SLEEP_LIMIT; i++) brake.observe(`sleep ${i}`, i);
    expect(brake.observe('sleep 1000', SLEEP_WINDOW_MS + 10).action).toBe('none');
  });

  it('a non-sleep command does not trip on an already-full sleep window', () => {
    const brake = new LoopBrake();
    for (let i = 1; i <= SLEEP_LIMIT; i++) brake.observe(`sleep ${i}`, i);
    brake.startTurn();
    expect(brake.observe('git status', 50).action).toBe('none');
  });
});

describe('loopBrakeNote', () => {
  it('names the shape and tells the model to annotate and stop', () => {
    expect(loopBrakeNote('repeat', 5)).toContain('same command 5 times');
    expect(loopBrakeNote('sleep', 10)).toContain('10 sleep calls');
    expect(loopBrakeNote('sleep', 10)).toContain('annotate-task');
  });
});
