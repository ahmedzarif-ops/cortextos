import { describe, it, expect } from 'vitest';
import { validateCronDispatch, VALID_CRON_DISPATCH_RUNTIMES } from '../../../src/utils/validate.js';

/**
 * ⛔ WHAT THIS VALIDATOR IS AND IS NOT.
 * It checks SHAPE. It cannot check whether a model EXISTS — this process has no
 * price list and no model catalogue — and a test that implied otherwise would be
 * the more dangerous artifact, because a green "model validated" reads as
 * "the model is real". Existence is settled by the wrapper at fire time (exit 65)
 * and lands on the receipt. These tests assert only what the code can actually know.
 */
describe('validateCronDispatch', () => {
  it('accepts the minimal valid block', () => {
    expect(() => validateCronDispatch({ runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash' })).not.toThrow();
  });

  it('accepts the optional fields', () => {
    expect(() => validateCronDispatch({
      runtime: 'hermes', model: 'deepseek/deepseek-v4.1-flash',
      max_tokens: 512, project: 'dubia', purpose: 'nightly lane digest',
    })).not.toThrow();
  });

  describe('an unknown runtime is REFUSED, never defaulted', () => {
    it.each(['claude', 'codex', 'openai', '', 'HERMES'])('rejects %j', (runtime) => {
      expect(() => validateCronDispatch({ runtime, model: 'a/b' })).toThrow(/dispatch runtime/);
    });

    it('says why defaulting would be worse than refusing', () => {
      expect(() => validateCronDispatch({ runtime: 'claude', model: 'a/b' }))
        .toThrow(/never quietly run on the seat model/);
    });

    it('the accepted list is exactly what the dispatcher implements', () => {
      expect([...VALID_CRON_DISPATCH_RUNTIMES]).toEqual(['hermes']);
    });
  });

  describe('a floating ALIAS is refused — a pin that moves is not a pin', () => {
    it.each(['deepseek/deepseek-latest', 'claude-opus-latest', '~latest'])('rejects %j', (model) => {
      expect(() => validateCronDispatch({ runtime: 'hermes', model })).toThrow(/ALIAS/);
    });

    it('a DATED id containing the word latest-like text is still fine', () => {
      expect(() => validateCronDispatch({ runtime: 'hermes', model: 'anthropic/claude-latest-gen-20260401' })).not.toThrow();
    });
  });

  it('rejects a missing or empty model', () => {
    expect(() => validateCronDispatch({ runtime: 'hermes' })).toThrow(/`model` is required/);
    expect(() => validateCronDispatch({ runtime: 'hermes', model: '   ' })).toThrow();
  });

  it('rejects a model id with path or shell characters', () => {
    expect(() => validateCronDispatch({ runtime: 'hermes', model: '../../etc/passwd' })).toThrow();
    expect(() => validateCronDispatch({ runtime: 'hermes', model: 'a/b; rm -rf /' })).toThrow();
  });

  it('rejects a non-object', () => {
    for (const bad of [null, undefined, 'hermes', 42, ['hermes']]) {
      expect(() => validateCronDispatch(bad)).toThrow(/expected an object/);
    }
  });

  describe('max_tokens is a COST BOUND, so it must be a positive integer', () => {
    it.each([0, -1, 1.5, '512', NaN])('rejects %j', (mt) => {
      expect(() => validateCronDispatch({ runtime: 'hermes', model: 'a/b', max_tokens: mt })).toThrow(/max_tokens/);
    });

    it('absent is fine — the dispatcher supplies the default', () => {
      expect(() => validateCronDispatch({ runtime: 'hermes', model: 'a/b', max_tokens: undefined })).not.toThrow();
    });
  });

  it('rejects a project that is not a ledger key', () => {
    expect(() => validateCronDispatch({ runtime: 'hermes', model: 'a/b', project: 'Fleet Lane!' })).toThrow(/project/);
    expect(() => validateCronDispatch({ runtime: 'hermes', model: 'a/b', project: '' })).toThrow(/project/);
  });

  it('rejects an empty purpose but allows it to be absent', () => {
    expect(() => validateCronDispatch({ runtime: 'hermes', model: 'a/b', purpose: '  ' })).toThrow(/purpose/);
    expect(() => validateCronDispatch({ runtime: 'hermes', model: 'a/b' })).not.toThrow();
  });
});
