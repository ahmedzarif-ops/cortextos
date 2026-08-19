import { describe, expect, it } from 'vitest';
import { shouldSendRecoveryNotification } from '../../../src/daemon/agent-manager.js';

describe('crash recovery notification gate', () => {
  it('requires a running, bootstrapped process in the same crash generation', () => {
    expect(shouldSendRecoveryNotification({ status: 'running', crashCount: 2 }, 2, true)).toBe(true);
    expect(shouldSendRecoveryNotification({ status: 'running', crashCount: 2 }, 2, false)).toBe(false);
    expect(shouldSendRecoveryNotification({ status: 'crashed', crashCount: 2 }, 2, true)).toBe(false);
    expect(shouldSendRecoveryNotification({ status: 'running', crashCount: 3 }, 2, true)).toBe(false);
  });
});
