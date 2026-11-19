# Chapter 14 — SSO audit and Federation ID reconciliation

> **Maturity status: `local-tested`.** The reference implementation is read-only and dependency-free. Its 121 tests run offline in CI on Linux and Windows, on Node.js 20 and 22. **It does not validate SSO.** It compares a list of approved identities with a snapshot of Salesforce users and reports differences. A read-only adapter can build that snapshot through the Salesforce CLI, but it has only been tested against a fake CLI. No Salesforce org, identity provider or SSO login has been involved. See [Evidence](#13-evidence) and [Limitations](#12-limitations).

| Verification | Status | Evidence |
|--------------|--------|----------|
| Offline unit tests validated in CI | **Verified.** 121 of 121 on GitHub-hosted runners: Linux and Windows, Node.js 20 and 22 (the earlier 55 passed on `main`: [run](https://github.com/leadlike/salesforce-devops/actions/runs/44461346263)) | __CI_RUN_URL_V03__ |
| Salesforce CLI integration | **Implemented, not verified.** The adapter is tested only against a fake CLI runner. The real CLI's output shape was taken from documentation, and no snapshot has ever been produced from a real org | None |
| Azure DevOps Server integration | **Not yet verified.** The example pipeline has only been checked as valid YAML | None |
| GitLab CI integration | **Not yet verified.** The example pipeline has only been checked as valid YAML | None |
| Live Salesforce run | **Not yet verified.** Nothing has run against a Salesforce org | None |
| Actual SSO login verification | **Not yet verified.** No user has signed in through an identity provider for this chapter | None |
| Post-refresh recovery | **Not yet verified.** No sandbox has been refreshed and recovered | None |

## 1. Problem

After a sandbox refresh, a copy of production arrives with production's users, and often with production's SSO configuration. Teams then have to make single sign-on work again for the people who should have access. When a Federation ID is missing, wrong or shared, one of two things happens: the right person cannot sign in, or the wrong person can.

Reconciliation answers one narrow question before anyone attempts a login: **does each approved person have exactly the Federation ID we approved, on an active user, in this org?**

## 2. Why Federation IDs matter, and why not just email

With SAML single sign-on, Salesforce receives an assertion from the identity provider (IdP) and has to decide which Salesforce user it refers to. Depending on configuration, that decision is made with the user's Federation ID or with the username. The Federation ID is therefore a **security-relevant identifier**: whoever holds a value that the IdP asserts can sign in as that user.

An e-mail address is a poor substitute:

- E-mail addresses are contact data. People change them, share aliases and receive mail for several addresses.
- A sandbox refresh typically alters e-mail addresses and usernames on purpose, so that test systems do not mail real people. Anything keyed on them breaks at exactly the moment you need it.
- Treating "Federation ID equals e-mail" as a rule hides the cases where it does not hold.

This module never infers identity from an e-mail address, and never assumes that a Federation ID equals one.

## 3. How correlation works: the approved `userKey`

To compare a baseline with an org you need a stable way to say "this baseline entry is that Salesforce user". The module uses an **approved correlation identifier**, called `userKey`.

- `userKey` is assigned and approved by people, outside this module. It is an opaque label such as `employee-101`.
- It is never derived from the Salesforce record Id, the username, the name or the e-mail address.
- The same `userKey` must appear in the baseline and in the snapshot.

The snapshot adapter fills `userKey` with one rule: **the value of the single field named in the policy, used exactly as stored.** The policy accepts only `EmployeeNumber` or a custom field ending in `__c`. Fields such as `Email`, `Username`, `FederationIdentifier` and `Id` are rejected when the policy is loaded.

| User in the org | Treatment |
|-----------------|-----------|
| Has a valid key | Included in the snapshot |
| Active, no usable key (empty, padded, invalid characters, too long) | Counted in `uncorrelatedUsers`. **This prevents a PASS** |
| Inactive, no usable key | Counted in diagnostics only; an inactive user cannot sign in |
| User type not listed in the policy | Excluded and counted in diagnostics |
| Two users with the same key | Both kept; the reconciliation reports `AMBIGUOUS` |

If correlation is wrong, every later result is wrong. A wrong `userKey` mapping is a baseline or key-data defect, not a reconciliation defect. Whether the chosen field is populated accurately in a real org is **not verified**.

The full live procedure is in the [SSO audit workflow](sso-audit-workflow.md).

## 4. Salesforce users and identity provider identities

Two populations exist and they are not the same set.

| Population | Source of truth | Held by this module |
|------------|-----------------|---------------------|
| Approved identities: who should be able to sign in, and with which Federation ID | A protected, reviewed baseline | The **baseline** input |
| Salesforce users: who exists in the org and what their Federation ID currently is | The org | The **snapshot** input |
| IdP identities: who the identity provider will assert | The identity provider | **Not used.** The IdP is not queried |

Reconciliation compares the first two. It does not prove that the IdP will assert the value the baseline lists. That requires a login test, which this chapter does not provide.

## 5. Input contract

Both documents are JSON with `schemaVersion: 1`. The schema is **closed**: unknown fields are rejected, not ignored.

Baseline:

```json
{
  "schemaVersion": 1,
  "orgKey": "fictional-qa",
  "identities": [
    { "userKey": "admin-001", "federationId": "employee-101" }
  ]
}
```

Snapshot:

```json
{
  "schemaVersion": 1,
  "orgKey": "fictional-qa",
  "users": [
    { "userKey": "admin-001", "active": true, "federationId": "employee-101" }
  ],
  "totalSize": 1,
  "done": true,
  "uncorrelatedUsers": 0
}
```

| Field | Rule |
|-------|------|
| `schemaVersion` | The number `1`. Anything else, including the string `"1"`, is unverifiable |
| `orgKey` | Matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Must be identical in both documents (case-sensitive) |
| `identities` | Non-empty array, at most 10,000 entries. **An empty baseline is unverifiable.** |
| `users` | Array, at most 250,000 entries |
| `userKey` | Matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` |
| baseline `federationId` | Non-empty string, no leading or trailing whitespace |
| snapshot `federationId` | String or `null`. Absent is treated as `null` |
| `active` | A boolean. `"true"` and `1` are rejected |
| `totalSize` (optional) | Non-negative integer. If present it must equal the number of users |
| `done` (optional) | Boolean. If `false`, the snapshot is unverifiable |
| `uncorrelatedUsers` (optional) | Non-negative integer: active users that could not be given a `userKey`. Absent means 0. Greater than 0 prevents `PASS` |
| Federation ID characters | Control characters, invisible and bidirectional-formatting characters and the replacement character are rejected, so identifiers cannot disguise themselves in logs |

File rules: at most 64 MiB, nesting at most 8 levels, valid JSON, **no duplicate object keys**, an optional UTF-8 byte order mark is accepted (Windows tools write one).

Comparison of Federation IDs is **exact and case-sensitive**. No trimming, normalization or case folding is applied. Whether this matches how your identity provider and Salesforce compare values must be confirmed in your environment; this repository has not verified it.

## 6. Reconciliation algorithm

The function is pure: no file, network or process access.

1. Validate both documents against the closed schema and the limits. Any violation stops with `UNVERIFIABLE`.
2. Stop with `UNVERIFIABLE` if the `orgKey` values differ, if `done` is `false`, or if `totalSize` disagrees with the user count.
3. Index baseline entries and snapshot users by `userKey` using `Map` objects, so keys such as `constructor` are ordinary data.
4. For each baseline entry, assign the **first** status that applies:

| Order | Status | Condition |
|-------|--------|-----------|
| 1 | `AMBIGUOUS` | The `userKey` is duplicated in the baseline or in the snapshot, or the expected Federation ID is shared by more than one baseline entry |
| 2 | `USER_NOT_FOUND` | No snapshot user has this `userKey` |
| 3 | `INACTIVE` | The user exists but is inactive |
| 4 | `DUPLICATE_ACTUAL` | The user's actual Federation ID is held by more than one snapshot user |
| 5 | `MISSING` | The user has no Federation ID (null, empty or whitespace) |
| 6 | `MISMATCH` | The actual value differs from the expected value |
| 7 | `MATCH` | The values are identical |

5. Every snapshot user whose `userKey` is not in the baseline becomes `UNMANAGED` (or `AMBIGUOUS` if that key is duplicated).
6. Sort findings by `userKey` in UTF-16 code unit order. This does not depend on the machine's locale.
7. The verdict is `PASS` only if there is at least one finding, **no active user is uncorrelated**, and every finding is `MATCH`. Otherwise it is `REVIEW_REQUIRED`.

An unmanaged user therefore prevents `PASS`, even if every approved identity matches.

## 7. Output contract

```json
{
  "schemaVersion": 1,
  "orgKey": "fictional-qa",
  "mode": "READ_ONLY",
  "verdict": "REVIEW_REQUIRED",
  "counts": { "INACTIVE": 1, "MATCH": 1, "MISMATCH": 1, "MISSING": 1 },
  "uncorrelatedUsers": 0,
  "findings": [ { "userKey": "admin-001", "status": "MATCH" } ]
}
```

| Exit code | Meaning | Output |
|-----------|---------|--------|
| 0 | `PASS`: every baseline identity matches and there are no unmanaged users | JSON on stdout |
| 2 | `REVIEW_REQUIRED`: at least one finding needs a human decision | JSON on stdout |
| 3 | `UNVERIFIABLE`: invalid, inconsistent or unreadable input, a limit was exceeded, or an internal error occurred | nothing on stdout; one line on stderr: `UNVERIFIABLE [E_CODE]: fixed message. No changes were made.` |

Only exit code 0 is success. A pipeline must not treat 2 or 3 as success. Error messages are fixed strings and never contain input values.

**Federation ID values are never written to the output.** `userKey` values are. A `userKey` identifies a person indirectly, so treat the output as internal data: do not publish it, and do not attach it to a public pull request.

## 8. Security assumptions

1. **Git is not an identity vault.** The real baseline, which maps people to Federation IDs, must not be committed to this or any public repository. The fixtures here are fictional.
2. **The baseline is trusted input, and the module cannot tell whether it is.** A reconciliation passes against whatever baseline it is given. If an attacker can change the baseline, they can make an unsafe org pass.
3. **Do not let an unreviewed pull request supply both the baseline and the policy that interprets it.** Keep the baseline in a protected repository or protected store, require independent review for changes, and pin the version the pipeline reads. The same controls described for the Org Guard policy apply; see [Chapter 8, Section 9](08-org-guard.md#9-protecting-the-guard-and-its-policy-from-untrusted-pull-requests).
4. **The snapshot is trusted only as far as its producer.** No signature or provenance is checked. A forged snapshot passes if it matches the baseline.
5. **Output is not a secret-free guarantee for other steps** in the same pipeline.
6. **No credentials are needed or accepted.** The module reads two local files. It has no network, process-spawning or write capability, and a test asserts that its source stays that way.

## 9. Security review of the delivered module

The module was delivered as `sso-continuity-v0.2.zip` and imported unmodified in a first commit so that every change is reviewable. Each item below was **reproduced by running the delivered code** before it was changed. The delivered module passed its own 12 tests and had no known failing behavior.

| # | Confirmed issue (as delivered) | Effect | Correction | Regression test |
|---|--------------------------------|--------|------------|-----------------|
| D1 | An empty baseline with an empty snapshot returned `PASS` | A vacuous success: nothing was verified | Empty baseline is `E_BASELINE_EMPTY`; `PASS` requires at least one finding | `an empty baseline is unverifiable` |
| D2 | A snapshot declaring `done: false` and a larger `totalSize` was accepted and returned `PASS` | A truncated export can hide duplicates and missing users | Both fields are validated; mismatch or `false` is `E_SNAPSHOT_INCOMPLETE` | `incomplete snapshots are unverifiable` |
| D3 | Findings were sorted with `localeCompare` | Output order differed between `en_US` and `sv_SE` machines, so output was not deterministic | Code-unit order | `output is deterministic`, plus a mutation check |
| D4 | The CLI called `process.exit()` right after printing | Output piped to another process was cut at 65,536 bytes (146,176 bytes were produced) | `process.exitCode` | `large output is delivered completely through a pipe` |
| D5 | Unknown fields were silently ignored | A misspelled key such as `userkey` was dropped without notice | Closed schema | `unknown fields are rejected` |
| D6 | Duplicate JSON keys were accepted, last value wins | A reviewer can read one value while the program uses another | Duplicate keys are `E_INPUT_DUPLICATE_KEY` | `duplicate object keys are rejected` |
| D7 | A UTF-8 byte order mark made the file unparseable | Files saved by common Windows tools failed | One leading BOM is accepted | `a UTF-8 byte order mark is accepted` |
| D8 | Whitespace, control and bidirectional characters were accepted in identifiers | Output and logs could be visually spoofed | Character allow list for keys, deny list for Federation IDs | `invisible, bidirectional and control characters ... are rejected` |
| D9 | The parser's error message quoted part of the input at library level | Fragments of identity data in an exception message | Fixed messages; parser message dropped | `invalid JSON is rejected with a fixed message` |
| D10 | No limit on file size, record count or nesting | Unbounded memory and time on untrusted input. A 300,000-user input took 279 ms and a 200,000-level nesting parsed without error in my runs, so **no exploit was demonstrated**; the limits are hardening | Limits, each reporting `UNVERIFIABLE` | `record limits are enforced`, `excessive nesting is rejected` |
| D11 | `npm test` used the pattern `test/*.test.js`. Node.js 20 given that pattern literally fails with "Could not find" | Fails where the shell does not expand the glob, for example `cmd.exe` on Windows | `node --test` with automatic discovery | The CI matrix runs on Windows |
| D12 | The README said exit 0 means "all managed records match", but an unmanaged user produces exit 2 | Documentation contradicted behavior (the behavior is the safer one) | Documentation corrected | `an unmanaged user alone downgrades an otherwise clean result` |
| D13 | The bundled workflow had no `permissions`, no path filter and no `fail-fast: false` | Broader token scope than needed; runs on unrelated changes | Replaced by a workflow that follows the existing Org Guard conventions | Workflow run |

Checked and **found safe** as delivered: keys named `__proto__` and `constructor` did not pollute `Object.prototype` (Maps are used); `orgKey` comparison is case-sensitive; invalid input, a missing file and wrong argument counts all exited with 3; the CLI's stderr message did not echo input.

## 10. Failure scenarios

| Scenario | Result | What a person should do |
|----------|--------|-------------------------|
| Sandbox refresh cleared all Federation IDs | `MISSING` for every identity, exit 2 | Follow the recovery procedure for your org once one exists (Chapter 16, not yet written) |
| Two users carry the same Federation ID | `DUPLICATE_ACTUAL`, exit 2 | Find which assignment is wrong before anyone signs in |
| An approved person's user was deactivated | `INACTIVE`, exit 2 | Decide whether reactivation is intended |
| Someone created an extra user | `UNMANAGED`, exit 2 | Review whether the user should exist and be approved |
| The snapshot is from another org | `E_ORG_MISMATCH`, exit 3 | Fix the pipeline's target; run Org Guard first |
| The snapshot export stopped early | `E_SNAPSHOT_INCOMPLETE`, exit 3 | Re-run the export |
| The baseline was emptied | `E_BASELINE_EMPTY`, exit 3 | Treat as a baseline defect or tampering |
| An unexpected exception | `E_INTERNAL`, exit 3 | Report it; no detail is printed because it could contain identity data |

## 11. Reading the result correctly

`PASS` means: for the approved identities, the snapshot holds exactly the approved Federation IDs, on active users, with no duplicates and no extra users. It does **not** mean:

- that the baseline is correct or authorized,
- that the snapshot is genuine or complete beyond its own declared size,
- that the identity provider will assert those values,
- that SAML settings, certificates, Auth Providers or Connected Apps are correct,
- that anyone can actually sign in.

## 12. Limitations

- **Never run against a real org.** The Salesforce CLI adapter is tested against a fake runner and fictional fixtures only. The CLI output shape, the field names and the pagination behavior are unverified against a real org.
- **Large orgs may fail closed.** The adapter requires `totalSize` to equal the records returned, so a CLI that returns a partial result produces `E_QUERY_INCOMPLETE` rather than a partial audit.
- **Key data quality is unverified.** The correlation rule is deterministic, but whether `EmployeeNumber` or your custom field is populated accurately is a property of your org.
- **Permissions.** Reading SSO configuration needs administrative read access (see the [workflow](sso-audit-workflow.md#permissions-the-read-only-user-is-not-minimal)).
- **No collision escalation.** If an unmanaged user holds the Federation ID that a managed user is expected to have, the result is `MISMATCH` for the managed user and `UNMANAGED` for the holder. The relationship between the two is not reported.
- **Exact comparison only.** Case, normalization and whitespace rules of the real systems are unverified.
- **Snapshot provenance is not checked.**
- **`userKey` appears in output.** There is no redaction or hashing option yet.
- **Limits are fixed defaults** and are not configurable from the command line.
- **Maintenance:** [Salesforce-native tooling, open-source projects and commercial platforms](../README.md#when-not-to-build-this-yourself) already cover parts of this area. Evaluate them first.

## 13. Evidence

| Claim | Evidence | Reproduce |
|-------|----------|-----------|
| 121 tests pass offline | __CI_RUN_URL_V03__ and the local run | `cd scripts/sso-continuity && npm test` |
| Each confirmed defect is caught by a test | A mutation check applied nine deliberate regressions one at a time (the defects D1 to D6 and D10 as delivered, a safety property that a test asserts, and printing an internal error message); each made at least one test fail | Re-introduce a change from the table in Section 9 and run the suite |
| No credentials are needed | The suite and the demonstration run with an empty environment | `env -i PATH="$PATH" node --test` |
| The module cannot write to Salesforce or to disk, call out, or read the environment, and only one file can start a process | Tests scan the source; every CLI call is checked to be `sf data query` of an allow-listed SELECT | `test/cli.test.mjs`, `test/live-cli.test.mjs` |
| Eleven further deliberate regressions in the live path were each caught | Mutation check: skipping the org check, case-insensitive org IDs, e-mail as correlation field, ignoring `totalSize` or `done`, letting uncorrelated users pass, dropping the SAML warning, allowing a secret field, printing a raw issuer URL, ignoring the policy pin, counting inactive users as blocking | Re-introduce a change and run the suite |
| Two crashes were found and fixed | A `null` record raised a `TypeError` in the snapshot and inventory builders; both now fail closed with `E_CLI_OUTPUT` | `non-object records fail closed` tests |

Not evidence: this chapter has no Salesforce run, no IdP interaction and no login result.

## 14. Path to the next maturity level

1. Run `snapshot`, `inventory` and `verify` against a real sandbox with a reviewed read-only user, and compare the real CLI output with the shape the code expects.
2. Check that the correlation field is populated accurately in that org.
3. Run the pipeline examples on a real Azure DevOps Server or GitLab instance.
4. Only then consider `ci-validated`. It also requires an actual SSO login check, which is a separate capability described in the [SSO continuity architecture](sso-continuity-architecture.md).

## 15. References

- [Maturity policy and verification matrix](../README.md#maturity-policy)
- [SSO audit workflow](sso-audit-workflow.md)
- [Post-refresh recovery architecture (design)](sso-post-refresh-recovery-architecture.md)
- [SSO continuity architecture (future modules)](sso-continuity-architecture.md)
- [Chapter 8 — Org Guard](08-org-guard.md)
- [Module README](../scripts/sso-continuity/README.md)
