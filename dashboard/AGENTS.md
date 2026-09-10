@AGENTS.md

---

## Dashboard codex coverage

The dashboard renders `runtime: codex-app-server` agents identically to claude agents. The two surfaces that needed codex-aware logic (PR-08) are:

- **Cost view** — `dashboard/src/lib/cost-parser.ts` discovers Claude transcripts and Codex session cumulative logs. `usage-normalizer.ts` validates identities/deltas and disjoint token buckets; `usage-pricing.ts` uses exact versioned prices with explicit provider/billing/tier/region/context evidence. Unknown metadata yields null cost. SQLite v2 preserves legacy rows separately. See `docs/usage-accounting-v2.md`.
- **Fleet health view** — `computeFleetHealth` in `src/daemon/ipc-server.ts` is fully runtime-agnostic; codex agents appear in the fleet summary and cron table with the same row shape and state machine as claude agents. The runtime badge is set from `config.json.runtime`.

The codex-only test peer at `dashboard/src/lib/__tests__/cost-parser-codex.test.ts` is the mutation gate: deliberately break codex pricing in `cost-parser.ts` and this suite must fail. Run `npm run test:codex` from the repo root to execute it alongside the integration peers (`tests/integration/fleet-health-mixed-codex-claude.test.ts`, `tests/integration/codex-bus-roundtrip.test.ts`, etc.).
