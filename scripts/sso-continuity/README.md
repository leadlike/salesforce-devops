# SSO continuity: Federation ID reconciliation

Read-only reference implementation of [Chapter 14](../../docs/14-sso-audit-federation-id-reconciliation.md). It compares an approved list of Federation IDs with a snapshot of Salesforce users, and can build that snapshot through the Salesforce CLI. All data in this directory is fictional.

**Status: `local-tested`.** Offline tests only. The Salesforce CLI path is tested against a fake runner and **has never run against a real org**. Nothing has run against an identity provider, and this tool does **not** verify that anyone can sign in. See the chapter for the verification matrix and limitations, and the [audit workflow](../../docs/sso-audit-workflow.md) for how to run it.

## Run

Requires Node.js 20 or later. No dependencies, no network, no credentials.

```
npm test            # runs every test in test/ (node --test)
npm run audit:demo  # runs the fictional example; exits with 2
```

Offline audit of two files:

```
node src/cli.mjs <baseline.json> <snapshot.json>
```

Live, read-only commands (need an authenticated Salesforce CLI and a policy file; see `fixtures/policy.example.json`):

```
node src/live-cli.mjs snapshot  --policy P --target-org ALIAS
node src/live-cli.mjs inventory --policy P --target-org ALIAS
node src/live-cli.mjs verify    --policy P --baseline B --target-org ALIAS --policy-sha256 H
```

These run only `sf data query` with a fixed set of SELECT statements. They cannot create, update, delete or deploy anything.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Every baseline identity matches and there are no unmanaged users |
| 2 | Findings require review |
| 3 | Input is invalid or unverifiable, or an internal error occurred |

Only `0` is success. Federation ID values are never printed. `userKey` values are, so treat the output as internal.

## Layout

| Path | Purpose |
|------|---------|
| `src/reconcile.mjs` | Pure reconciliation function |
| `src/schema.mjs` | Closed input schemas |
| `src/json-input.mjs` | Strict JSON loading: size, depth, duplicate keys |
| `src/limits.mjs` | Resource limits |
| `src/errors.mjs` | Error type and stable error codes |
| `src/cli.mjs` | Offline audit entry point |
| `src/live-cli.mjs` | Read-only live commands: `snapshot`, `inventory`, `verify` |
| `src/policy.mjs` | Live-run policy: org identifier, correlation field, digest pin |
| `src/queries.mjs` | The only SOQL that can run, behind a read-only gate |
| `src/sf-runner.mjs` | The only file that starts a process: `sf data query` |
| `src/snapshot.mjs` | Deterministic `userKey` correlation and snapshot building |
| `src/inventory.mjs` | SAML configuration and Auth Provider inventory |
| `fixtures/` | Fictional example inputs |
| `test/` | Tests (`node:test`, no dependencies) |
| `testkit/` | Test helpers, including a fake Salesforce CLI runner. Kept outside `test/` |

## Not implemented

Certificate monitoring, Connected App inspection, drift detection, backup, post-refresh comparison, login verification, and **write operations of any kind**. See the [future architecture](../../docs/sso-continuity-architecture.md) and the [recovery design](../../docs/sso-post-refresh-recovery-architecture.md).

## Security notes

- Do not commit a real baseline. A baseline maps people to Federation IDs and belongs in a protected store.
- Do not let an unreviewed pull request supply both the baseline and the policy that interprets it.
- A passing result is only as trustworthy as the baseline and the snapshot it was given.
