/**
 * Child entrypoint. Runs ONLY inside the trusted child created by
 * launch-trusted-usage-read.mjs.
 *
 * Contract, deliberately narrow:
 *  - reads its inputs from argv/env supplied by the boundary, not from
 *    ambient caller state;
 *  - writes exactly ONE line of JSON to stdout and nothing else, ever;
 *  - writes NOTHING to stderr, so there is no channel for a raw message to
 *    escape on (guard blocker 2 travelled the stderr path);
 *  - exits 0 on success, 1 on a coded failure. The code is in the JSON.
 */
import { readAuthenticatedUsage } from './read-authenticated-usage.mjs';
import { toPublicCode } from './usage-error-codes.mjs';

const emit = (payload) => { process.stdout.write(`${JSON.stringify(payload)}\n`); };

try {
  const ctxRoot = process.argv[2];
  const usage = await readAuthenticatedUsage(ctxRoot, {
    envToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    timeoutMs: Number.parseInt(process.env.USAGE_TIMEOUT_MS ?? '', 10) || undefined,
  });
  emit({ ok: true, usage });
  process.exit(0);
} catch (err) {
  emit({ ok: false, code: toPublicCode(err) });
  process.exit(1);
}
