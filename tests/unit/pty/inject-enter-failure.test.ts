import { describe, expect, it, vi } from 'vitest';
import { injectMessage } from '../../../src/pty/inject';

// The Enter written after the bracketed paste IS the submit. Without it the content
// is not delivered — it sits in the runtime's composer, unsent, until some LATER
// injection's Enter flushes it. Observed in the field: pasted content surfaced 73
// minutes afterwards, prepended to the next injection, inside a single turn.
//
// That failure used to go to a bare `console.warn`, so the one step that actually
// submits could fail while every layer above reported success. These tests pin the
// callback that lets a caller with a real logging surface record it.

describe('injectMessage propagates a dropped Enter instead of swallowing it', () => {
  it('calls onEnterError when the deferred Enter write throws', async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    let writes = 0;

    injectMessage(
      (data: string) => {
        writes += 1;
        // Succeed for the paste, throw only for the Enter — this models a PTY torn
        // down during the 300 ms window, which is the documented real cause.
        if (data === '\r') throw new Error('pty is null');
        void data;
      },
      'hello',
      300,
      (msg) => errors.push(msg),
    );

    // CONTROL: before the timer fires there must be NO error. Without this, a callback
    // invoked eagerly (or by some unrelated path) would pass the assertion below.
    expect(errors).toHaveLength(0);
    expect(writes).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(400);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('NOT submitted');
    vi.useRealTimers();
  });

  it('does NOT call onEnterError when the Enter lands — the negative control', async () => {
    vi.useFakeTimers();
    const errors: string[] = [];

    injectMessage(() => { /* every write succeeds */ }, 'hello', 300, (msg) => errors.push(msg));
    await vi.advanceTimersByTimeAsync(400);

    // Without this arm the test above cannot distinguish "the callback fires on failure"
    // from "the callback always fires".
    expect(errors).toHaveLength(0);
    vi.useRealTimers();
  });

  it('falls back to console.warn when no callback is supplied, so existing callers are unaffected', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });

    injectMessage((data: string) => { if (data === '\r') throw new Error('pty is null'); }, 'hello', 300);
    await vi.advanceTimersByTimeAsync(400);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('NOT submitted');
    warn.mockRestore();
    vi.useRealTimers();
  });
});
