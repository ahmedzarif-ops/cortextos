# Lifecycle status schemas

These checked-in JSON Schemas are the normative machine-readable contracts for
`cortextos lifecycle status`.

`cortext.status/v1` and `cortext.status.redacted/v1` describe the legacy bridge
profile only. Managed lifecycle profiles will use a future discriminated
contract instead of placing non-null managed evidence into this legacy shape.
Check results bind each policy to its exact v1 identifier and require empty
reasons on pass or at least one unique closed reason on failure. Redacted
capabilities, observations, isolation evidence, and version strings are closed
public surfaces; the redactor reconstructs their metadata rather than copying
untrusted strings.

When a status type changes, update its schema and the corresponding TypeScript
type together. Run the focused lifecycle and schema tests before committing:

```bash
npm test -- --run tests/unit/lifecycle/legacy-status.test.ts tests/unit/lifecycle/status-schema.test.ts
```

The schema tests validate emitted local and redacted snapshots, both error
envelopes, and recursive rejection of additional redacted properties. Schema
generation is intentionally not part of dependency installation: contributors
on every supported Node version receive the same reviewed contracts without an
additional code-generation supply chain.
