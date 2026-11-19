# SSO continuity: Federation ID reconciliation

Offline, read-only reference implementation of [Chapter 14](../../docs/14-sso-audit-federation-id-reconciliation.md). It compares an approved list of Federation IDs with a snapshot of Salesforce users. All data in this directory is fictional.

**Status: `local-tested`.** Offline tests only. Nothing has run against a Salesforce org or an identity provider, and this tool does **not** verify that anyone can sign in. See the chapter for the verification matrix and limitations.

## Run

Requires Node.js 20 or later. No dependencies, no network, no credentials.

```
npm test            # runs every test in test/ (node --test)
npm run audit:demo  # runs the fictional example; exits with 2
```

Direct use:

```
node src/cli.mjs <baseline.json> <snapshot.json>
```

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
| `src/cli.mjs` | Command-line entry point |
| `fixtures/` | Fictional example inputs |
| `test/` | Tests (`node:test`, no dependencies) |
| `testkit/` | Test helpers, kept outside `test/` |

## Not implemented

No Salesforce CLI integration, no SAML, certificate, Auth Provider or Connected App inspection, no backup or post-refresh comparison, and **no write operations of any kind**. See the [future architecture](../../docs/sso-continuity-architecture.md).

## Security notes

- Do not commit a real baseline. A baseline maps people to Federation IDs and belongs in a protected store.
- Do not let an unreviewed pull request supply both the baseline and the policy that interprets it.
- A passing result is only as trustworthy as the baseline and the snapshot it was given.
