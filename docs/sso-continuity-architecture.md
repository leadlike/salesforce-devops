# SSO continuity architecture (future, not implemented)

> **Status: mostly `concept`.** Module 2 (Federation ID audit) and parts of modules 1, 3 and 5 are implemented and tested offline against a fake Salesforce CLI: [Chapter 14](14-sso-audit-federation-id-reconciliation.md) and the [audit workflow](sso-audit-workflow.md). Everything else is a design. Nothing here has run against a Salesforce org, an identity provider or a login. The recovery design is in [post-refresh recovery architecture](sso-post-refresh-recovery-architecture.md).

## Purpose

Keep single sign-on working across environment changes, above all sandbox refreshes, without weakening access control. The design is a set of small, separate modules. Each module has one job, a stated input and output, and an explicit maturity label.

## Constraints that apply to every module

- **Read-only by default.** For now no module writes to Salesforce. There is no apply mode, and no code in this repository modifies a Federation ID.
- **Fictional data in Git.** No real identity mapping, certificate, tenant identifier, URL or secret is committed.
- **Fail closed.** An unverifiable condition never yields success.
- **No secrets in output.** Output is designed so that it can be shared inside an organization without exposing credentials or Federation ID values.
- **Vendor-neutral at the CI layer.** Modules are plain programs with exit codes. Pipeline definitions only call them.

## Module overview

| # | Module | Purpose | Reads | Writes | Status |
|---|--------|---------|-------|--------|--------|
| 1 | Salesforce SSO inventory | List which SSO mechanisms an org has configured | Org metadata | none | `local-tested`, partial: SAML configurations and Auth Providers only (`inventory`) |
| 2 | Federation ID audit | Compare approved identities with a snapshot of users | Baseline file, snapshot file; optionally a live read through `sf data query` | none | `local-tested` ([Chapter 14](14-sso-audit-federation-id-reconciliation.md)); the live read is tested only against a fake CLI |
| 3 | SAML configuration inspection | Report SAML settings and compare with an approved description | Org metadata | none | `concept`; `inventory` reports identity mapping, provisioning and issuer and login URL fingerprints, with no comparison to an approved description |
| 4 | Certificate expiration monitoring | Report certificates and their expiry dates | Org metadata | none | `concept` |
| 5 | Auth Provider and Connected App inspection | Report configured providers and apps | Org metadata | none | `concept`; Auth Providers are listed by `inventory`, Connected Apps are not covered |
| 6 | SSO drift detection | Compare current configuration with an approved baseline | Modules 1, 3, 4, 5 output | none | `concept` |
| 7 | Pre-refresh backup | Capture what must be restored after a refresh | Org metadata, user data | A protected store outside Git | `concept` |
| 8 | Post-refresh comparison | Compare the refreshed org with the pre-refresh capture | Backup, org metadata | none | `concept` |
| 9 | Controlled Federation ID restoration | Restore approved Federation IDs after a refresh | Approved baseline, module 8 output | **The only module that would write** | `concept`, **not authorized to build yet** |
| 10 | SSO readiness reporting | Combine module results into one reviewable report | Modules 1–8 output | A report file | `concept` |

Dependencies: 6 needs 1, 3, 4, 5. 8 needs 7. 9 needs 2, 8 and the authorization conditions below. 10 needs whichever of the others exist.

## What each module would and would not claim

| Module | Would show | Would not show |
|--------|-----------|----------------|
| 1 Inventory | Which mechanisms are configured | That any of them works |
| 2 Federation ID audit | Whether approved Federation IDs are present, unique and on active users | That the identity provider asserts them |
| 3 SAML inspection | Settings as stored in the org | That the identity provider holds matching settings |
| 4 Certificates | Expiry dates found in the org | Certificates held only by the identity provider |
| 5 Providers and apps | Configuration present | That sign-in through them works |
| 6 Drift | Differences from an approved description | That the approved description is right |
| 7 Backup | What was captured | That the capture is sufficient to recover |
| 8 Comparison | Differences after a refresh | Cause or intent |
| 9 Restoration | Not applicable until built | Not applicable |
| 10 Readiness | Aggregated module results | Anything beyond its inputs. It must list missing inputs as missing |

No combination of these modules proves that a person can sign in. That needs a separate login verification, which is not part of this list and is not designed yet.

## Restoration: a separately authorized capability

Module 9 is the first one that could change security-relevant data. It is **not** planned as an extension of the audit. It would be designed, reviewed and authorized as its own capability. A design would have to meet all of these conditions before any code that writes is accepted:

1. **Independently verifiable authorization.** The decision to restore is recorded by someone other than the author of the change, in a system the pipeline cannot edit.
2. **Trusted identity provenance.** The baseline comes from a protected source with its own review, and its version is pinned. An unreviewed pull request must not supply both the baseline and the policy that interprets it.
3. **Target-org verification.** The org is identified by its immutable identifier before any write, using the same fail-closed approach as [Org Guard](08-org-guard.md).
4. **Least privilege.** A dedicated integration identity that can modify only the fields required, in the intended orgs only.
5. **Audit evidence.** Every change records who authorized it, which baseline version was used, and what changed, in storage that the pipeline cannot rewrite.
6. **Fail-closed behavior.** Any doubt stops the run with no change. Partial application is itself a failure that must be reported.
7. **No production credentials in public CI.** Credentials are not placed in GitHub Actions or any pipeline that untrusted changes can influence.

Until those conditions are written down and reviewed, the repository will not contain restoration code.

## Order of work

1. Module 2 and the inventory against a real sandbox (read-only). This is the next milestone.
2. Modules 3, 4, 5 completed as read-only inspections.
3. Modules 7 and 8 for refresh comparison.
4. Modules 6 and 10 on top of those results.
5. Only then: a design review for module 9.

This order may change as evidence is gathered.
