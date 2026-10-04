/**
 * Loop brake for codex-app-server seats.
 *
 * Codex seats have no Claude PreToolUse hook, and project-level Codex hooks
 * only load after an interactive trust step, so the adapter itself watches
 * each `commandExecution` item as it starts. Two shapes trip the brake:
 * the same command run REPEAT_LIMIT times in a row within one turn, and
 * SLEEP_LIMIT sleep calls inside SLEEP_WINDOW_MS (sleep-polling). The first
 * trip steers the turn with a stop note; INTERRUPT_AFTER further hits in the
 * same turn interrupt it.
 *
 * Pure and clock-injected so it can be tested without an app-server.
 */

export type LoopBrakeMode = 'off' | 'shadow' | 'on';
export type LoopBrakeKind = 'repeat' | 'sleep';

export interface LoopBrakeVerdict {
  action: 'none' | 'steer' | 'interrupt';
  kind?: LoopBrakeKind;
  count?: number;
}

export const REPEAT_LIMIT = 5;
export const SLEEP_LIMIT = 10;
export const SLEEP_WINDOW_MS = 30 * 60 * 1000;
export const INTERRUPT_AFTER = 3;

// `sleep` as a command word followed by an argument: matches `sleep 30`,
// `sleep 30; next`, `do x; sleep 60; done`, `sleep $N`, `sleep 5m`, and the
// same inside `/bin/zsh -lc '...'`. Not `sleeper 3` or `--sleep 3`.
const SLEEP_RE = /(?:^|[\s;&|('"`])sleep\s+[\d$"'{]/;

export function isSleepCommand(command: string): boolean {
  return SLEEP_RE.test(command);
}

export function resolveLoopBrakeMode(value: unknown): LoopBrakeMode {
  return value === 'off' || value === 'on' ? value : 'shadow';
}

export function loopBrakeNote(kind: LoopBrakeKind, count: number): string {
  const what = kind === 'repeat'
    ? `You have run the same command ${count} times in a row.`
    : `You have made ${count} sleep calls in the last 30 minutes.`;
  return `[LOOP BRAKE] ${what} Stop polling. Do not sleep-wait: the daemon delivers ` +
    'messages and task changes to you as they happen. Write what you are waiting on ' +
    'into the task with `cortextos bus annotate-task <id> "<note>"`, then end this turn.';
}

export class LoopBrake {
  private lastCommand: string | null = null;
  private repeatCount = 0;
  private sleeps: number[] = [];
  private steered = false;
  private hitsSinceSteer = 0;

  /** A new turn starts: the repeat run and the steer state begin again. */
  startTurn(): void {
    this.lastCommand = null;
    this.repeatCount = 0;
    this.steered = false;
    this.hitsSinceSteer = 0;
  }

  observe(command: string, now: number): LoopBrakeVerdict {
    const normalised = command.trim().replace(/\s+/g, ' ');
    if (normalised === this.lastCommand) {
      this.repeatCount += 1;
    } else {
      this.lastCommand = normalised;
      this.repeatCount = 1;
    }
    this.sleeps = this.sleeps.filter((t) => now - t >= 0 && now - t < SLEEP_WINDOW_MS);
    if (isSleepCommand(command)) this.sleeps.push(now);

    let kind: LoopBrakeKind | null = null;
    let count = 0;
    if (this.repeatCount >= REPEAT_LIMIT) {
      kind = 'repeat';
      count = this.repeatCount;
    } else if (this.sleeps.length >= SLEEP_LIMIT && isSleepCommand(command)) {
      kind = 'sleep';
      count = this.sleeps.length;
    }
    if (!kind) return { action: 'none' };

    if (!this.steered) {
      this.steered = true;
      this.hitsSinceSteer = 0;
      return { action: 'steer', kind, count };
    }
    this.hitsSinceSteer += 1;
    if (this.hitsSinceSteer >= INTERRUPT_AFTER) {
      // The turn ends here; start the next one from a clean count.
      this.startTurn();
      this.sleeps = [];
      return { action: 'interrupt', kind, count };
    }
    return { action: 'none', kind, count };
  }
}
