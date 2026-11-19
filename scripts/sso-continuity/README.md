# SSO Continuity v0.2 — offline identity reconciliation reference

**Status:** local-tested only. This package has not been tested against Salesforce, an identity provider, or an actual sandbox refresh.

This is a fictional, vendor-neutral, read-only Node.js reference module. It reconciles an approved expected Federation ID baseline with a Salesforce-shaped snapshot, without contacting Salesforce or modifying any identities. It is **not** an SSO readiness certification and must not be used as an identity restoration tool.

## Run

Requires Node.js >= 20, no npm dependencies or credentials.

```sh
npm test
npm run audit:demo
```

`audit:demo` intentionally exits **2** because the fictional snapshot contains discrepancies. Exit 0 = all managed records match; 2 = review required; 3 = invalid/unverifiable inputs. In automation, do not treat exit 2 or 3 as success.

## Input contract

Both JSON documents require `schemaVersion: 1` and the same `orgKey`. Baseline `identities` contain stable fictional `userKey` and `federationId`. Snapshot `users` contain `userKey`, boolean `active`, and nullable/string `federationId`.

`userKey` is a pre-approved stable correlation key, **not** a Salesforce email, username, or IdP subject inferred by this program. The mapping process establishing this key must be separately authorized and validated. Never assume Federation ID equals email. The code does not connect to an IdP or verify that a Federation ID belongs to the intended person.

## Results and limitations

Findings: `MATCH`, `MISSING`, `MISMATCH`, `INACTIVE`, `DUPLICATE_ACTUAL`, `AMBIGUOUS`, `USER_NOT_FOUND`, `UNMANAGED`. Duplicate baseline identities and expected Federation IDs are ambiguous. Inputs are never changed. Results intentionally omit Federation ID values, though `userKey` is still potentially identifying in real environments.

**Not yet implemented:** Salesforce CLI integration; SAML, certificates, Auth Providers or Connected App inspection; authoritative identity mapping; protected storage; approval workflow; restore/apply; external SSO login validation; sandbox refresh recovery; CI validation. The program does not guarantee uniqueness across any unobserved Salesforce users or external IdP identities. A real implementation must query the full relevant scope, protect the baseline and outputs, and establish the identity authority before proposing changes.

## Security requirements for future integration

- Read-only service account for inventory; no permission to modify users.
- Protected identity baseline outside the public repository; no real identity data in Git.
- Fail closed on missing, malformed or cross-org input.
- Do not trust snapshot content or baseline changes from an untrusted pull request.
- Keep any future write path in a separately reviewed and authorized tool with explicit target org, baseline provenance and auditable approval.
- Use synthetic data for public demonstrations.

## Intended repository integration

Copy the module into `scripts/sso-continuity/` and link it from the identity chapter after review. This is a standalone delivery, not a commit to the public repository.
