# Post-refresh recovery architecture (design, not implemented)

> **Status: `concept`.** Nothing on this page is implemented except the read-only audit that it builds on ([audit workflow](sso-audit-workflow.md)). There is no backup tool, no comparison tool and **no code that modifies Salesforce**. This page prepares a design so that it can be reviewed before anything is built.

## 1. Problem

A sandbox refresh replaces a sandbox with a new copy. Afterwards, identity-related data may not be what the team expects, and single sign-on may fail for some or all people. Which fields survive a refresh is specific to the org and the data, and **must be observed, not assumed**. This design makes the observation systematic and makes any repair deliberate.

## 2. Principles

1. **Observe, then decide, then act.** Observation tools are read-only and run first. Any change is a separate step with its own approval.
2. **The plan is not the action.** A read-only tool produces a plan. A different tool, with different credentials, applies only an approved plan.
3. **Fail closed.** Any doubt about the org, the baseline, the plan or the approval stops the run with no change.
4. **Evidence outlives the pipeline.** What was observed, approved and changed is recorded where the pipeline cannot rewrite it.
5. **Recovery is not verification.** Restoring a value does not prove that people can sign in. Login verification is a separate capability.

## 3. Phases

| Phase | What happens | Tooling today |
|-------|--------------|---------------|
| P0 Prepare | Baseline approved, policy pinned, correlation key populated | Baseline and policy owners; the module validates them |
| P1 Capture before refresh | Record the state that matters: baseline version, inventory fingerprints, snapshot digest, diagnostics counts | `inventory` and `snapshot` exist; a protected capture store does not |
| P2 Refresh | Performed by the platform team, outside this tooling | None |
| P3 Re-establish the target | Confirm the org identity. **Do not assume the org identifier is unchanged**; confirm it and update the policy through review | Org Guard, `verify` |
| P4 Compare | Compare the refreshed org with the capture and the baseline | `verify` compares with the baseline. Comparison with a capture does not exist |
| P5 Decide | A person reviews the findings and decides what, if anything, to repair | Process |
| P6 Restore | Apply an approved plan | **Does not exist and is not authorized to be built yet** |
| P7 Verify sign-in | Prove that approved people can sign in | **Does not exist** |
| P8 Record | Store evidence | Process; a protected store does not exist |

## 4. Trust boundaries

| Zone | Contents | Who can change it | Untrusted inputs allowed? |
|------|----------|-------------------|---------------------------|
| Public repository | Code, fictional fixtures, documentation | Maintainers through pull requests | Yes: anyone proposes changes |
| Protected controls | Pinned module version, policy, baseline | Named owners, with independent review | No |
| Pipeline runtime | Short-lived credentials, the running job | The pipeline owner | No |
| Evidence store | Captures, plans, approvals, results | Append-only for the pipeline | No |
| The org | Users and configuration | Salesforce administrators and, for P6 only, the apply identity | Not applicable |

An unreviewed pull request must never supply both the identity baseline and the policy that interprets it.

## 5. Plan, approve, apply

A restoration capability, if built, is split into two tools.

| Tool | Reads | Writes | Credentials |
|------|-------|--------|-------------|
| Planner | Baseline, snapshot, policy | A plan document | Read-only |
| Applier | An approved plan | The Federation ID field of the users named in the plan | A dedicated identity with the narrowest possible write permission |

Requirements for the plan:

1. It lists exact changes: which `userKey`, from what status to what approved value. It never lists Federation ID values in logs.
2. It is bound to the org identifier, the baseline version and the snapshot digest it was computed from.
3. It has a content hash. Approval is recorded against that hash.
4. It has a maximum number of changes. A plan that exceeds it is rejected, not truncated.
5. It excludes anything ambiguous. `AMBIGUOUS`, `DUPLICATE_ACTUAL` and `UNMANAGED` findings are never auto-repaired.

Requirements for the applier:

1. It refuses any plan whose hash is not approved, or whose approval was given by the plan's own author.
2. It re-verifies the org identity and re-reads the affected users immediately before writing, and stops if any user no longer matches the state the plan assumed.
3. It writes nothing outside the fields and users in the plan, and it is idempotent.
4. It records each change, and stops on the first unexpected result. A partial run is reported as a failure.
5. It cannot run from a pipeline that an untrusted change can influence, and it holds no production credentials in a public CI service.

## 6. Failure scenarios

| Scenario | Safe behavior |
|----------|---------------|
| The org identifier changed after the refresh | Org Guard blocks. The policy is updated through review, not by the pipeline |
| A snapshot is incomplete | `E_QUERY_INCOMPLETE`; nothing is planned |
| The baseline was tampered with | Detected only if its version or digest is pinned and independently reviewed. This tooling cannot detect it alone |
| Two people share one Federation ID | Reported as `DUPLICATE_ACTUAL`; a person resolves it before any plan exists |
| The apply identity is compromised | Limited by its narrow permission and by the plan-hash binding. Not eliminated |
| The apply run stops halfway | Reported as failed with the list of completed changes; the next plan is computed from a fresh read |

## 7. Open questions

These are not answered by this repository and need evidence from a real sandbox:

1. Which identity fields change in a refresh in your org, and which are preserved?
2. Does the organization identifier change on refresh in your org?
3. How does the Salesforce CLI return large user sets, and what limits apply?
4. Which minimal permission allows reading Federation IDs without administrative configuration access?
5. Which minimal permission would allow writing only the Federation ID field?
6. How will sign-in be verified, and by whom?

## 8. Authorization

Writing code for P6 is **not** part of the current scope. It needs its own written design, review and explicit authorization, with the requirements in Section 5 and in the [SSO continuity architecture](sso-continuity-architecture.md#restoration-a-separately-authorized-capability).
