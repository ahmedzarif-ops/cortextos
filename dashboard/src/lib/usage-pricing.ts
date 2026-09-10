/** Frozen list-price observations, not invoices or subscription cash charges.
 * Add a new version rather than editing a published snapshot. No fuzzy aliases.
 */
export const PRICE_VERSION = '2026-09-10.v1';
export const PRICE_OBSERVED_AT = '2026-09-10T00:00:00Z';
const OPENAI = 'https://developers.openai.com/api/docs/pricing';
const CLAUDE = 'https://platform.claude.com/docs/en/about-claude/pricing';
export interface Price {
  provider: string;
  model: string;
  billing_mode: 'api';
  service_tier: 'standard';
  region: 'global';
  context_band: 'short' | 'long' | 'any';
  // USD / million tokens; normalized categories are disjoint.
  input: number; output: number; read: number; write: number; write1h: number;
  source: string;
}
const openai = (model: string, context_band: Price['context_band'], input: number, output: number, read: number, write: number): Price =>
  ({ provider: 'openai', model, billing_mode: 'api', service_tier: 'standard', region: 'global', context_band, input, output, read, write, write1h: 0, source: OPENAI });
const claude = (model: string, input: number, output: number, read = input / 10): Price =>
  ({ provider: 'anthropic', model, billing_mode: 'api', service_tier: 'standard', region: 'global', context_band: 'any', input, output, read, write: input * 1.25, write1h: input * 2, source: CLAUDE });
export const PRICES: readonly Price[] = [
  { ...openai('gpt-5-codex', 'any', 1.25, 10, .125, 0), source: 'https://developers.openai.com/api/docs/models/gpt-5-codex' },
  openai('gpt-6-astra', 'short', 10, 50, 1, 12.5),
  openai('gpt-6-astra', 'long', 20, 75, 2, 25),
  claude('claude-fable-5-1', 10, 50, .25),
  claude('claude-opus-4-6', 5, 25),
  claude('claude-sonnet-4-6', 3, 15),
  claude('claude-haiku-4-5', 1, 5),
];
export interface PriceContext {
  provider?: string; billing_mode?: string; service_tier?: string;
  region?: string; context_band?: string;
}
export function resolvePrice(model: string, context: PriceContext): Price | undefined {
  return PRICES.find(p => p.model === model && p.provider === context.provider &&
    p.billing_mode === context.billing_mode && p.service_tier === context.service_tier &&
    p.region === context.region && (p.context_band === 'any' || p.context_band === context.context_band));
}
export function priceMicros(p: Price, input: number, output: number, write = 0, read = 0, write1h = 0): number | null {
  const tokens = [input, output, write, read, write1h];
  if (!tokens.every(t => Number.isSafeInteger(t) && t >= 0)) return null;
  const amount = Math.round(input * p.input + output * p.output + write * p.write + read * p.read + write1h * p.write1h);
  return Number.isSafeInteger(amount) ? amount : null;
}
/** Explicit hypothetical standard/global API estimate. Never used to infer billing mode. */
export function calculateCost(model: string, input: number, output: number, write = 0, read = 0): number | null {
  const candidates = PRICES.filter(p => p.model === model && p.context_band === 'any');
  if (candidates.length !== 1) return null;
  const micros = priceMicros(candidates[0], input, output, write, read);
  return micros === null ? null : micros / 1e6;
}
