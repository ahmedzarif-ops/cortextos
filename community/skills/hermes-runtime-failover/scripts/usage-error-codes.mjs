/**
 * Fixed, allow-listed public error codes.
 *
 * Guard acceptance criterion 3: every network, header, parser and filesystem
 * failure must surface as one of these constants. A raw lower-layer
 * `error.message` must NEVER reach stdout, stderr, a receipt or an artifact —
 * on 9dba452 those messages carried `Bearer <token>` and response-body
 * fragments (guard blocker 2).
 *
 * The rule is structural, not stylistic: an Error object is allowed to travel
 * internally, but only its CODE crosses a boundary a human or a log can see.
 */
export const USAGE_ERROR_CODES = Object.freeze([
  'E_ROOT_INVALID',          // CTX_ROOT missing / not absolute
  'E_TOKEN_MISSING',         // no usable credential
  'E_TOKEN_UNUSABLE',        // credential present but cannot form a header
  'E_ACCOUNT_UNBOUND',       // no canonical account was supplied to compare against
  'E_ACCOUNT_MISMATCH',      // account used is not the canonical expected one
  'E_HTTP_STATUS',           // non-2xx
  'E_NETWORK',               // transport failure
  'E_TIMEOUT',               // abort / deadline
  'E_RESPONSE_PARSE',        // body was not JSON
  'E_RESPONSE_SHAPE',        // JSON lacked required utilization fields
  'E_RANGE',                 // utilization outside 0..1
  'E_READER_DIGEST',         // module bytes did not match the pinned digest
  'E_LAUNCH',                // trusted child could not be created
  'E_CHILD_OUTPUT',          // child produced output we will not parse
  'E_INTERNAL',              // catch-all; never carries detail
]);

const ALLOWED = new Set(USAGE_ERROR_CODES);

/** An error that carries ONLY a code. Constructing it strips any detail. */
export class UsageError extends Error {
  constructor(code) {
    const safe = ALLOWED.has(code) ? code : 'E_INTERNAL';
    super(safe);
    this.name = 'UsageError';
    this.code = safe;
  }
}

/**
 * Convert anything thrown into a code. Deliberately ignores the input's
 * message: that is the whole point. A non-UsageError becomes E_INTERNAL.
 */
export const toPublicCode = (err) =>
  err instanceof UsageError && ALLOWED.has(err.code) ? err.code : 'E_INTERNAL';

export const isPublicCode = (value) => typeof value === 'string' && ALLOWED.has(value);
