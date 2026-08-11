# Lifecycle status schemas

These checked-in JSON Schemas are the normative machine-readable contracts for
`cortextos lifecycle status`.

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
