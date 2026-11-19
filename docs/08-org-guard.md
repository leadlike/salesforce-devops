# Chapter 8 — Org Guard

> **Draft. Not published.** This chapter is not linked from the chapter index and has not been merged into `main`.
>
> **Maturity status: `local-tested`.** The reference implementation passes an offline test suite (29 tests). It has **not** been run against a live Salesforce org, a real CI pipeline, Windows or any Node.js version other than the one listed under [Evidence](#evidence). See [Limitations](#limitations).

## 1. Problem

A Salesforce operation that reaches the wrong org is usually not a code defect. It is a **targeting** defect: an alias that was re-pointed, a pipeline variable copied from another environment, a credential that is valid for more orgs than intended.

Authentication succeeding tells you that you *can* act on an org. It does not tell you that it is the org you *meant*.

Org Guard is a small pre-flight check. Before a deployment, test run or data operation, it asks the Salesforce CLI who it is about to talk to and compares the answer with an explicit policy. If anything does not match, or cannot be established, the pipeline stops.

## 2. What Org Guard is not

- It is **not an authorization control.** It does not decide who may deploy. Salesforce permissions, pipeline approvals and branch protection do that.
- It is **not a substitute for least privilege.** An integration user that cannot modify production is a stronger control than a script that checks the target.
- It **cannot defend against someone who controls both the guard and its policy.** See the threat model.

It is a second line of defense that turns a silent mistake into a loud failure.

## 3. Threat model

| # | Threat | Example | Control in this design | Residual risk |
|---|--------|---------|------------------------|---------------|
| T1 | Alias points to the wrong org | A local alias is re-pointed after a re-authorization | Verify the org **ID** and username returned by the CLI, not the alias | None for this threat if the policy is correct |
| T2 | Production targeted by mistake | A variable from a UAT pipeline is reused | `environmentType` must match `IsSandbox`; explicit deny list | Requires an accurate policy |
| T3 | Look-alike instance URL | `...my.salesforce.com.attacker.test` | Exact host match against an allow list, no suffix or substring matching | None in the tested cases |
| T4 | CLI failure, timeout or malformed output | CLI prints a warning before the JSON; network stall | Fail closed: any failure yields `UNVERIFIABLE`, exit code 3, never PASS | Behavior of real CLI versions is unverified here |
| T5 | Inconsistent data sources | The two CLI calls describe different orgs | Cross-check the org IDs from both calls | Low |
| T6 | Secret leakage | Access token printed in logs | The report never prints the token; a test asserts this | Other scripts in your pipeline may still leak it |
| T7 | Shell injection through the target parameter | `--target-org "qa; rm -rf /"` | Strict character allow list for the target before any process is started | Low |
| T8 | Policy modified in the same change as the code | A pull request edits the policy to allow production | **Not mitigated by the script.** Requires controls outside it | **High if unaddressed**, see [Limitations](#limitations) |
| T9 | Check-then-use race | Alias changes between the guard and the deployment | **Not fully mitigated.** Deploy against the verified username in the same job | Medium |
| T10 | Offline mode used to bypass the check | A pipeline passes forged fixture files | Offline output is labeled "NOT a live verification" | **Medium**, depends on pipeline review |

## 4. Design

Two rules shape the code.

1. **Pure evaluation.** `evaluate()` takes plain data and returns a verdict. It performs no I/O, so every behavior can be tested offline without Salesforce credentials.
2. **Fail closed.** There are three outcomes, not two.

| Verdict | Exit code | Meaning |
|---------|-----------|---------|
| `PASS` | 0 | Every check matched the policy |
| `BLOCKED` | 2 | The org was identified and violates the policy |
| `UNVERIFIABLE` | 3 | The guard could not reach a trustworthy verdict, or the configuration is invalid |

Separating `BLOCKED` from `UNVERIFIABLE` matters operationally. The first means "wrong target"; the second means "the check itself is broken", which should page a different person.

### Checks

| Check | Passes when |
|-------|-------------|
| `deny-list` | The org ID is not on the deny list |
| `org-id` | The org ID equals the expected ID (compared on the canonical, case-sensitive 15-character form, so 15 and 18 character IDs are equivalent) |
| `environment-type` | `IsSandbox` from the `Organization` object agrees with `environmentType` |
| `instance-host` | The instance host is in the allow list (exact match) |
| `username` | The authenticated username equals the expected username (case-insensitive) |

Before these run, the guard verifies that the policy itself is valid (including that the expected org is not also on the deny list) and that both CLI results are well formed and describe the same org.

### CLI calls

The guard runs two commands, each with a hard timeout:

```
sf org display --target-org <target> --json
sf data query  --target-org <target> --query "SELECT Id, IsSandbox FROM Organization" --json
```

It relies on `id`, `username` and `instanceUrl` from the first, and on `Id` and `IsSandbox` of exactly one record from the second. **These field names are taken from the documented output shape and have not been compared against a live org by this repository.** Pin your CLI version and verify them in your environment.

## 5. Implementation

Source: [`scripts/org-guard/`](../scripts/org-guard/)

| File | Purpose |
|------|---------|
| `org-guard.mjs` | Library and command-line tool, no dependencies |
| `policy.example.json` | Fictional policy |
| `examples/*.json` | Fictional CLI output used for the offline demo and tests |
| `test/org-guard.test.mjs` | Offline test suite |

Node.js is used because the Salesforce CLI already requires it, so it is present wherever the guard must run. The built-in test runner means there is nothing to install.

### Policy

```json
{
  "expectedOrgId": "00D000000000QA1AAA",
  "environmentType": "sandbox",
  "expectedUsername": "ci-user@example-corp.com.qa",
  "allowedInstanceHosts": ["example-corp--qa.sandbox.my.salesforce.com"],
  "denyOrgIds": ["00D000000000PRDAAA"]
}
```

All values are fictional.

### Usage

```
node org-guard.mjs --policy policy.json --target-org <alias-or-username> [--timeout-ms 60000]
```

Offline demo, using recorded fictional output (never use this in a pipeline):

```
node org-guard.mjs --policy policy.json --offline-fixtures \
  --display-file examples/display-qa.json \
  --organization-file examples/organization-qa.json
```

## 6. Run the tests

Requirements: Node.js and nothing else. No Salesforce credentials and no network access.

```
cd scripts/org-guard
npm test
```

### Expected output (summary)

```
# tests 29
# pass 29
# fail 0
```

## 7. Expected outputs

The outputs below were produced by running the commands against the fictional fixtures.

### Correct target

```
MODE: offline-fixture (NOT a live verification)
PASS  deny-list: target org is not on the deny list
PASS  org-id: expected 00D000000000QA1, found 00D000000000QA1
PASS  environment-type: expected sandbox, found sandbox
PASS  instance-host: host example-corp--qa.sandbox.my.salesforce.com is allowed
PASS  username: expected ci-user@example-corp.com.qa, found ci-user@example-corp.com.qa
RESULT: PASS
```

Exit code 0.

### Wrong target (production)

```
MODE: offline-fixture (NOT a live verification)
FAIL  deny-list: target org is on the deny list
FAIL  org-id: expected 00D000000000QA1, found 00D000000000PRD
FAIL  environment-type: expected sandbox, found production
FAIL  instance-host: host example-corp.my.salesforce.com is not allowed
FAIL  username: expected ci-user@example-corp.com.qa, found ci-user@example-corp.com
RESULT: BLOCKED
```

Exit code 2. Every failing check is listed, which helps diagnose whether the mistake was a variable, an alias or a credential.

### Malformed input

```
MODE: n/a
FAIL  verification: fixture files are unreadable or not valid JSON
RESULT: UNVERIFIABLE
```

Exit code 3.

### Salesforce CLI not available

```
MODE: n/a
FAIL  verification: org display: could not run the Salesforce CLI (ENOENT); is "sf" installed and on PATH?
RESULT: UNVERIFIABLE
```

Exit code 3. This output was produced in an environment where `sf` is not installed. It is the only run of the live code path, and it exercised the failure branch, not a successful verification.

## 8. Negative test catalog

Every row is an automated test in `test/org-guard.test.mjs`.

| Scenario | Verdict |
|----------|---------|
| All checks match | PASS |
| Wrong org ID | BLOCKED |
| Org on the deny list | BLOCKED |
| Production target, sandbox expected | BLOCKED |
| Instance host not allowed | BLOCKED |
| Look-alike host (allowed host as a prefix of an attacker domain) | BLOCKED |
| Unexpected username | BLOCKED |
| 15 vs 18 character IDs for the same org | PASS |
| Org ID differing only by letter case | BLOCKED |
| `org display` reports failure | UNVERIFIABLE |
| Required field missing from `org display` | UNVERIFIABLE |
| Malformed org ID | UNVERIFIABLE |
| Malformed `instanceUrl` | UNVERIFIABLE |
| Organization query returns zero or several records | UNVERIFIABLE |
| `IsSandbox` missing or not a boolean | UNVERIFIABLE |
| The two CLI results describe different orgs | UNVERIFIABLE |
| Each invalid-policy rule, including expected org also denied | UNVERIFIABLE |
| CLI times out | UNVERIFIABLE |
| CLI prints non-JSON text before the JSON | UNVERIFIABLE |
| CLI not installed | UNVERIFIABLE |
| CLI crashes with no output | UNVERIFIABLE |
| Target alias containing shell syntax (`;`, `&&`, `$(...)`, spaces, empty, missing) | UNVERIFIABLE, CLI never started |
| Missing, unknown or unreadable arguments | UNVERIFIABLE |
| Access token in the CLI output | Never printed |

## 9. Pipeline integration (illustrative)

The step below shows the intended placement. **It has not been executed in any CI system.**

```yaml
- script: node scripts/org-guard/org-guard.mjs --policy $(POLICY_PATH) --target-org $(SF_TARGET_USERNAME)
  displayName: Org Guard
```

Placement rules that matter more than the syntax:

1. Run the guard **after** authentication and **before** any operation that changes or reads sensitive data.
2. Make every later step depend on it, so a non-zero exit stops the job.
3. Run later steps against the **username that was verified**, not an alias, to narrow the check-then-use window (T9).
4. Never pass `--offline-fixtures` in a pipeline.

## 10. Limitations

This section is part of the pattern. Read it before copying the code.

1. **Not validated against a live org.** The CLI output shapes are assumed from documentation. The first live run may reveal differences by CLI version, org type or edition.
2. **Single-platform evidence.** Tests ran on one Node.js version on Linux. Windows agents, including `.cmd` resolution for `sf` and argument quoting, are untested. The Windows branch of the runner is unexercised.
3. **Policy trust (T8).** If a pull request can change both the guard and its policy, the guard protects nothing against a malicious or careless change. Keep the policy outside the changed code path: a protected branch, required reviewers for the policy file, or values supplied by the pipeline from a protected store. This script cannot enforce that.
4. **Check-then-use race (T9).** The guard verifies a target at one moment. It cannot guarantee that a later command reaches the same org.
5. **Offline mode (T10).** It exists for demonstration and testing. A pipeline that allows it can be made to pass with forged files.
6. **It trusts the CLI and the org.** A compromised workstation, a tampered CLI or a manipulated response defeats it.
7. **Policy accuracy.** A wrong expected org ID is a wrong control. The deny list and the expected ID should be reviewed like any security setting.
8. **No logging or evidence archive.** The guard prints a report. Persisting it as a build artifact with the commit SHA is left to the pipeline.
9. **Not a performance-tested component.** Timeouts are configurable but have not been tuned.

## 11. Evidence

| Item | Result |
|------|--------|
| Offline test suite | 29 of 29 passing |
| Runtime | Node.js v22.23.5, Linux, no Salesforce CLI, no network access to Salesforce |
| Mutation checks (manual) | Three deliberate defects were introduced and the suite was re-run: (1) host check disabled, (2) timeout treated as success, (3) access token printed. Each was detected by at least one failing test. The token defect was **not** detected at first; the test was strengthened to capture raw standard output and the defect was then caught |
| Live verification against Salesforce | **None** |
| CI run | **None** |
| Windows, other Node.js versions | **Not tested** |

### Compatibility matrix

| Component | Tested | Untested |
|-----------|--------|----------|
| Node.js | 22.23.5 | 20.x, 24.x |
| OS | Linux | Windows, macOS |
| Salesforce CLI (`sf`) | none | all versions |

## 12. Path to the next maturity level

To move from `local-tested` to `ci-validated`:

1. Run the guard against a real sandbox and record the actual CLI output, replacing the assumed fixtures.
2. Run it from a self-hosted agent, on the operating system your agents use.
3. Show a PASS, a deliberate BLOCKED (wrong target) and a deliberate UNVERIFIABLE (CLI unavailable) in a real pipeline, with sanitized logs.
4. Document the protected location of the policy and demonstrate that a pull request cannot alter it unnoticed.
5. Record the CLI and Node.js versions used.
