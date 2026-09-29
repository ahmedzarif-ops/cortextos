// Preload for hook subprocess tests: every fetch() is recorded to
// $RECORD_FETCH_LOG and then fails, so a test can prove whether a hook
// ATTEMPTED an outbound send without touching the network.
const { appendFileSync } = require('node:fs');
globalThis.fetch = async (url) => {
  appendFileSync(process.env.RECORD_FETCH_LOG, `${String(url).replace(/bot[^/]+/, 'bot<token>')}\n`);
  throw new Error('network disabled in test');
};
