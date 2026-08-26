# Worker A — Hermes Runtime Audit

invocation:
  profile: `sentinelparitya`
  model: `z-ai/glm-5.3-flash`
  provider: `nous`
  reasoning: `high`
  mode: read-only bounded audit

## Headline finding

The three modified tests describe a design that does not exist in source yet. No production file contains `hermes_profile`, `hermes_provider`, `hermes_reasoning`, `hermes_cron_ownership`, or `hermesProfileHome` outside tests. This is test-first work awaiting implementation.

## Exact caller-signature facts

1. `hermesDbExists(hermesHome?: string): boolean` is in `src/pty/hermes-pty.ts`. Its sole production caller is `AgentProcess.shouldContinue()` in `src/daemon/agent-process.ts`, passing `process.env['HERMES_HOME']`. New tests require `hermesDbExists(profile: string, root?: string)` and exported `hermesProfileHome(profile, root)`.
2. `HermesPTY(env, config, logPath?)` construction is unchanged; `AgentConfig` grows fields. Production construction is in `src/daemon/agent-process.ts`.
3. `buildClaudeArgs(mode, prompt)` is the protected override in `src/pty/hermes-pty.ts`; base declaration is in `src/pty/agent-pty.ts`. Tests require full pins on fresh and continue, with `--continue` appended last.
4. `customizeEnv(ptyEnv)` exists in the shared env path in `src/pty/agent-pty.ts`; it is the correct seam for setting per-agent `HERMES_HOME` and `HERMES_PROFILE`.
5. `reloadCrons` and `startAgentCronScheduler` in `src/daemon/agent-manager.ts` both skip Hermes unconditionally.

## Mismatches and overlooked call sites

- `.force-fresh` is unreachable for Hermes because `shouldContinue()` returns from the Hermes branch before checking the marker. Marker-first ordering is the actual fix.
- `AgentProcess` reads daemon-level `process.env['HERMES_HOME']`, which cannot vary per agent. The profile must come from agent config; root derivation must match the PTY environment.
- `AgentConfig` lacks all four typed fields.
- Both cron guards contradict the new `hermes_cron_ownership: 'cortextos'` test.
- `src/cli/add-agent.ts` accepts `runtime: 'hermes'` but validates none of the required profile fields; this is an additional enforcement point.
- `templates/hermes/config.json` lacks profile/provider/reasoning/cron ownership settings.
- Existing comments claiming no model flags and agent-env-only `HERMES_HOME` will become stale.

## Minimum safe patch order

1. Add typed config fields.
2. Implement `hermesProfileHome`, profile-aware `hermesDbExists`, profile validation, full launch pins, and profile env in `src/pty/hermes-pty.ts`.
3. Move `.force-fresh` ahead of Hermes continuation and use the configured profile in `src/daemon/agent-process.ts`.
4. Make both cron guards ownership-aware.
5. Update template and add-agent validation.

## Tests still missing

- Cross-module consistency between `customizeEnv` profile home and the path `shouldContinue()` probes.
- End-to-end cron fire/injection for Hermes with cortextOS ownership.
- Regression that native ownership preserves the skip.
- Add-agent/import validation for missing, malformed, and `default` profiles.
- Spawn integration proving profile-scoped startup file and PTY environment.
- Malformed-profile failure at spawn time, not only direct `buildClaudeArgs` invocation.
- Hermes profile flow integration/e2e coverage.

worker_statement: No files modified; git state untouched.
