# Chapter 8 — Org Guard

> **Draft. Not published.** This chapter is not linked from the chapter index and has not been merged into `main`.
>
> **Maturity status: `local-tested`.** The reference implementation passes an offline test suite (50 tests) on Linux and Windows, on Node.js 20 and 22. It has **not** been run against a live Salesforce org, with a real Salesforce CLI, or in an Azure DevOps Server pipeline. The status stays `local-tested` until those things are demonstrated. See [Evidence](#12-evidence) and [Limitations](#11-limitations).

## 1. Problem

A Salesforce operation that reaches the wrong org is usually not a code defect. It is a **targeting** defect: an alias that was re-pointed, a pipeline variable copied from another environment, a credential that is valid for more orgs than intended.

Authentication succeeding tells you that you *can* act on an org. It does not tell you that it is the org you *meant*.

Org Guard is a small pre-flight check. Before a deployment, test run or data operation, it asks the Salesforce CLI who it is about to talk to and compares the answer with an explicit policy. If anything does not match, or cannot be established, the pipeline stops.

## 2. What Org Guard is not

- It is **not an authorization control.** It does not decide who may deploy. Salesforce permissions, pipeline approvals and branch protection do that.
- It is **not a substitute for least privilege.** An integration user that cannot modify production is a stronger control than a script that checks the target.
- It **cannot defend against someone who controls both the guard and its policy.** [Section 9](#9-protecting-the-guard-and-its-policy-from-untrusted-pull-requests) describes how to keep both out of reach of an untrusted change.

It is a second line of defense that turns a silent mistake into a loud failure.

## 3. Threat model

| # | Threat | Example | Control in this design | Residual risk |
|---|--------|---------|------------------------|---------------|
| T1 | Alias points to the wrong org | A local alias is re-pointed after a re-authorization | Verify the org **ID** and username returned by the CLI, not the alias | None for this threat if the policy is correct |
| T2 | Production targeted by mistake | A variable from a UAT pipeline is reused | `environmentType` must match `IsSandbox`; explicit deny list | Requires an accurate policy |
| T3 | Look-alike instance URL | `...my.salesforce.com.attacker.test` | Exact host match against an allow list, no suffix or substring matching | None in the tested cases |
| T4 | CLI failure, timeout or malformed output | CLI prints a warning before the JSON; network stall | Fail closed: any failure yields `UNVERIFIABLE`, exit code 3, never PASS | Behavior of real CLI versions is unverified here |
| T5 | Inconsistent data sources | The two CLI calls describe different orgs | Cross-check the org IDs from both calls | Low |
| T6 | Secret leakage | Access token or session ID in logs, in an error message or in a stack trace | The report never prints the token; every printed line is redacted; unexpected errors print a fixed message and no stack; arguments and policy values are not echoed; CLI `stderr` is never printed; tests assert each of these | Redaction is pattern-based and best effort. Other steps of your pipeline may still leak secrets |
| T7 | Shell injection through the target parameter | `--target-org "qa; rm -rf /"` | Strict character allow list before any process is started; on Windows, a second allow list for the whole command line | Low |
| T8 | Policy modified in the same change as the code | A pull request edits the policy to allow production | The policy can be pinned to an administrator-approved SHA-256 digest held outside the repository. The guard, the policy and the pipeline definition are kept in a protected repository. See [Section 9](#9-protecting-the-guard-and-its-policy-from-untrusted-pull-requests) | **Depends entirely on those controls being configured.** The script cannot enforce them |
| T9 | Check-then-use race | Alias changes between the guard and the deployment | **Not fully mitigated.** Deploy against the verified username in the same job | Medium |
| T10 | Offline mode used to bypass the check | A pipeline passes forged fixture files | Offline output is labeled "NOT a live verification" | **Medium**, depends on pipeline review |

## 4. Design

Three rules shape the code.

1. **Pure evaluation.** `evaluate()` takes plain data and returns a verdict. It performs no I/O, so every behavior can be tested offline without Salesforce credentials.
2. **Fail closed.** There are three outcomes, not two. Every failure, including an unexpected internal error, is `UNVERIFIABLE`.
3. **No secrets in output.** Every printed line passes through `redact()`.

| Verdict | Exit code | Meaning |
|---------|-----------|---------|
| `PASS` | 0 | Every check matched the policy |
| `BLOCKED` | 2 | The org was identified and violates the policy |
| `UNVERIFIABLE` | 3 | The guard could not reach a trustworthy verdict, or the configuration is invalid |

Only `PASS` exits with 0. Separating `BLOCKED` from `UNVERIFIABLE` matters operationally. The first means "wrong target"; the second means "the check itself is broken", which should page a different person.

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

### Error handling and output hygiene

- All exceptions are converted to `UNVERIFIABLE` (exit code 3). Messages of unexpected errors and stack traces are not printed, because they can contain data returned by the CLI.
- Arguments and policy values are not echoed in error messages.
- CLI `stderr` is never printed.
- `redact()` masks anything shaped like a Salesforce session ID (`<org ID>!<token>`) and the access token returned by the CLI.

### Running the CLI on Windows

Windows installs the Salesforce CLI as a `.cmd` file, which Node.js can only start through a shell. Passing an argument array together with a shell makes Node.js join the arguments without quoting, so the SOQL text would be split at its spaces. The guard therefore builds **one** command line, quotes arguments that contain spaces or commas, and refuses any argument that contains a shell metacharacter instead of trying to escape it.

## 5. Implementation

Source: [`scripts/org-guard/`](../scripts/org-guard/)

| File | Purpose |
|------|---------|
| `org-guard.mjs` | Library and command-line tool, no dependencies |
| `policy.example.json` | Fictional policy |
| `examples/*.json` | Fictional CLI output used for the offline demo and tests |
| `test/org-guard.test.mjs` | Baseline test suite (29 tests) |
| `test/org-guard.hardening.test.mjs` | Tests for exit codes, secret leakage, policy pinning, Windows and timeouts (21 tests) |

Other files: [`pipelines/azure-devops/`](../pipelines/azure-devops/) (illustrative example) and [`.github/workflows/org-guard-tests.yml`](../.github/workflows/org-guard-tests.yml) (runs the offline tests on Linux and Windows).

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
node org-guard.mjs --policy policy.json --target-org <alias-or-username>
                   [--policy-sha256 <64 hex characters>] [--timeout-ms 60000]
```

`--policy-sha256` pins the policy file. If the digest of the file differs, the result is `UNVERIFIABLE`. `--timeout-ms` accepts an integer from 1 to 600000.

Offline demo, using recorded fictional output (never use this in a pipeline):

```
node org-guard.mjs --policy policy.json --offline-fixtures \
  --display-file examples/display-qa.json \
  --organization-file examples/organization-qa.json
```

## 6. Run the tests

Requirements: Node.js 20 or later and nothing else. No Salesforce credentials and no network access.

```
cd scripts/org-guard
npm test
```

### Expected output (summary)

```
# tests 50
# pass 50
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

### Policy file does not match its pinned digest

```
MODE: n/a
FAIL  verification: policy file does not match the pinned SHA-256 digest
RESULT: UNVERIFIABLE
```

Exit code 3.

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

Every row is an automated test.

| Scenario | Verdict or result |
|----------|-------------------|
| All checks match | PASS (exit 0) |
| Wrong org ID | BLOCKED (exit 2) |
| Org on the deny list | BLOCKED |
| Production target, sandbox expected | BLOCKED |
| Instance host not allowed | BLOCKED |
| Look-alike host (allowed host as a prefix of an attacker domain) | BLOCKED |
| Unexpected username | BLOCKED |
| 15 vs 18 character IDs for the same org | PASS |
| Org ID differing only by letter case | BLOCKED |
| `org display` reports failure | UNVERIFIABLE (exit 3) |
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
| Target alias containing shell syntax | UNVERIFIABLE, CLI never started |
| Missing, unknown or unreadable arguments | UNVERIFIABLE |
| **Real process exit codes** for PASS, BLOCKED and several UNVERIFIABLE cases | 0, 2 and 3 |
| Live mode with no `sf` on `PATH`, in a real process | exit 3 |
| Invariant over 15 mutated inputs: verdict and exit code always agree, and only PASS exits with 0 | holds |
| Unexpected internal error (a thrown `TypeError` carrying a secret) | UNVERIFIABLE; no message, no stack, no secret printed |
| Failing CLI response that contains a token in its JSON and in `stderr` | Token never printed |
| Known access token forced into a printed field | Masked as `[REDACTED]` |
| Argument such as `--password=...` | Not echoed |
| Invalid policy value | Not echoed |
| Policy digest matches (lower or upper case) | PASS |
| Policy modified after the digest was approved, and the modified policy would PASS | UNVERIFIABLE (exit 3) |
| Malformed digest | UNVERIFIABLE |
| Windows: SOQL text quoted as one argument | Yes |
| Windows: arguments containing `"`, `%`, `^`, `&`, `|`, `<`, `>`, `(`, `)`, `!`, `;`, a backtick, a line break or empty | Refused |
| Windows and non-Windows spawn plans | One command string with a shell; argument array without a shell |
| Invalid `--timeout-ms` (`abc`, `0`, `-5`, `1.5`, empty, `600001`, `NaN`, `1e9`) | UNVERIFIABLE, CLI never started |

## 9. Protecting the guard and its policy from untrusted pull requests

The guard checks the target against a policy. If a pull request can change the guard, the policy, or the pipeline definition that runs them, the check can be weakened by the very change it is meant to protect against. The script cannot solve this by itself. The trust anchor has to be **outside** the control of the change under review.

### What an untrusted pull request must not be able to change

| Element | Where it should live | Why |
|---------|----------------------|-----|
| Pipeline definition that runs the guard | A protected repository, consumed through `extends` | A pull request can edit the YAML in its own repository |
| Guard script | The same protected repository, referenced by a pinned tag | Otherwise the script can be replaced |
| Policy file | The same protected repository | Otherwise the allowed org can be changed |
| SHA-256 of the policy | A variable group (or secret variable) that only administrators can edit | Detects a policy change even if the file location is compromised |
| Deployment credentials (JWT key, client ID) | Secure file and variable group, both **protected resources** with checks | The checks are what force pipelines through the approved template |

### How the pieces fit

1. The product repository contains a short pipeline that does nothing except `extends` a template from the protected repository ([`azure-pipelines.yml`](../pipelines/azure-devops/azure-pipelines.yml)).
2. The template runs authentication, the guard and the validation ([`guarded-validate.yml`](../pipelines/azure-devops/templates/guarded-validate.yml)).
3. The environment and the credential resources carry a **Required template** check, so a pipeline that does not extend the approved template cannot use them.
4. The protected repository has branch policies that require review, with automatically included reviewers for the guard and policy paths.
5. The policy digest is supplied from an administrator-only variable group and passed with `--policy-sha256`. A change to the policy therefore needs two independent actions: an approved change in the protected repository and a new digest set by an administrator.

### Azure DevOps Server features this relies on

- **Required template check.** Microsoft documents it as a check on protected resources such as environments and service connections. When the check is in place, a pipeline fails if it does not extend the referenced template. Microsoft's template-security page lists Azure DevOps Server 2022 and 2020. Microsoft's pages name environments, service connections and agent pools; third-party guides also list variable groups and secure files. Check in the Microsoft documentation for your version which resource types accept the check before relying on it for the JWT key.
- **Automatically included reviewers with path filters.** Branch policies can add required reviewers when a pull request changes files under given paths. Use it for the guard, the policy and the templates.
- **`extends` with a pinned `ref`.** The repository resource can reference a tag. Make sure the tag cannot be moved by the people who propose changes.

Confirm every one of these on **your** server version and edition. This repository has not verified them on a live Azure DevOps Server.

### What the digest pin does and does not do

| It protects against | It does not protect against |
|---------------------|----------------------------|
| A change to the policy file that is not matched by a new digest | A change to the guard script |
| A policy file swapped after review | A change to the pipeline definition that removes the guard |
| | Someone who can edit both the policy and the administrator-only variable |

The remaining protection comes from the protected repository and the required template check. The pin is one layer, not the whole control.

### A test of the idea

The test `policy pin: a modified policy is rejected even though it would otherwise PASS` shows both sides. Without a pin, a policy edited to describe production passes against production fixtures. With the approved digest, the same edit exits with code 3.

## 10. Azure DevOps Server integration: how the exit code stops deployment

The example is in [`pipelines/azure-devops/`](../pipelines/azure-devops/). **It has not been executed on Azure DevOps Server. It has only been checked to be valid YAML.** The placement of the steps matters more than the syntax.

```yaml
- script: >
    node $(Pipeline.Workspace)/s/PipelineControls/org-guard/org-guard.mjs
    --policy $(Pipeline.Workspace)/s/PipelineControls/policies/qa.json
    --policy-sha256 $(ORG_GUARD_POLICY_SHA256_QA)
    --target-org ci-user@example-corp.com.qa
  displayName: Org Guard

- script: >
    sf project deploy start --dry-run
    --target-org ci-user@example-corp.com.qa
    --source-dir force-app --test-level RunLocalTests
  displayName: Validate deployment (dry run)
```

How a non-zero exit code stops the deployment:

1. The guard exits with 2 (`BLOCKED`) or 3 (`UNVERIFIABLE`). A script step that exits with a non-zero code fails the step.
2. Steps have the default condition `succeeded()`, so the validation step is skipped after a failed guard step.
3. The job fails, and the stage fails with it.

Rules that keep this working:

- Run the guard **after** authentication and **before** any operation that changes or reads sensitive data.
- Do not add `continueOnError`, and do not give the deployment step `condition: always()`.
- Do not pipe the guard output (for example into `tee`). A pipe returns the exit code of the last command and hides the failure, unless the shell is configured to propagate it.
- Run later steps against the **username that was verified**, not an alias (T9).
- Never pass `--offline-fixtures` in a pipeline.
- Put a **Required template** check on the environment so that this template cannot be skipped.

Unverified points in the example: whether `checkout` steps behave as written inside a deployment job on your server version, the exact Salesforce CLI flags for your CLI version, and the runtime behavior of the variable names.

## 11. Limitations

This section is part of the pattern. Read it before copying the code.

1. **Not validated against a live org.** The CLI output shapes are assumed from documentation. The first live run may reveal differences by CLI version, org type or edition.
2. **Windows evidence is partial.** The tests run on GitHub-hosted Windows runners, where the Salesforce CLI is not installed. The Windows command line is verified as a string by unit tests, but it has never been executed with a real `sf.cmd`. Your own agents, their Node.js build and their locked-down policies are untested. With a shell, Node.js ends a timed-out run by stopping the shell; whether a child `sf` process survives has not been tested.
3. **Policy trust (T8).** The pin and the protected repository reduce the risk but depend on correct configuration of Azure DevOps. The script cannot detect that a check is missing. If the guard, its policy and the pipeline definition can all be changed by the same untrusted pull request, the guard protects nothing.
4. **The pin covers the policy only.** It does not cover the guard script or the pipeline definition.
5. **Required template checks apply only where a protected resource is used.** A pipeline that never touches a protected resource is not constrained by them. Credentials must therefore sit in protected resources.
6. **Availability by version.** Check that the features in Section 9 exist in your Azure DevOps Server version and edition.
7. **Check-then-use race (T9).** The guard verifies a target at one moment. It cannot guarantee that a later command reaches the same org.
8. **Offline mode (T10).** It exists for demonstration and testing. A pipeline that allows it can be made to pass with forged files.
9. **It trusts the CLI and the org.** A compromised workstation, a tampered CLI or a manipulated response defeats it.
10. **Redaction is best effort.** It masks session-ID-shaped strings and the token returned by the CLI. It cannot recognize every secret format.
11. **Policy accuracy.** A wrong expected org ID is a wrong control. The deny list and the expected ID should be reviewed like any security setting.
12. **No evidence archive.** The guard prints a report. Persisting it as a build artifact with the commit SHA is left to the pipeline.
13. **Digest rotation is manual.** Updating the approved digest is an administrative step that this repository does not automate.

## 12. Evidence

| Item | Result |
|------|--------|
| Offline test suite, local run | 50 of 50 passing: 29 baseline tests (unchanged) plus 21 added for the identified risks. Node.js v22.23.5, Linux |
| Offline test suite, GitHub-hosted runners | 50 of 50 passing in each of four jobs: Windows and Linux, Node.js 22.23.4 and 20.20.2. Run: <https://github.com/leadlike/salesforce-devops/actions/runs/44445871646> (commit `1cd3297`) |
| Mutation checks (manual) | Ten deliberate defects were introduced one at a time and the suite re-run: host check disabled, timeout treated as success, access token printed, digest never compared, redaction disabled, raw error message printed, Windows quoting removed, BLOCKED exiting with 0, unknown argument echoed, timeout not validated. Each is now detected by at least one failing test. Two were **not** detected at first (token printed through raw standard output, and the timeout check, whose test was neutralized because the program converts every exception into UNVERIFIABLE). Both tests were corrected and the defects were then caught |
| Live verification against Salesforce | **None** |
| Run in an Azure DevOps Server pipeline | **None** |
| Real Salesforce CLI (`sf`) | **Not installed in any test environment** |

### Compatibility matrix

| Component | Tested | Untested |
|-----------|--------|----------|
| Node.js | 20.20.2, 22.23.4 (CI), 22.23.5 (local) | 24.x |
| OS | Ubuntu (GitHub-hosted), Windows (GitHub-hosted) | macOS, your own Windows agents |
| Salesforce CLI (`sf`) | none | all versions |
| Azure DevOps Server | none | all versions |

The GitHub Actions run executes the **offline** tests only. It is not the CI validation described below, because it does not involve a Salesforce org or the Azure DevOps pipeline.

## 13. Path to the next maturity level

To move from `local-tested` to `ci-validated`:

1. Run the guard against a real sandbox with a real `sf` and record the actual CLI output, replacing the assumed fixtures.
2. Run it from a self-hosted agent, on the operating system your agents use.
3. Show a PASS, a deliberate BLOCKED (wrong target) and a deliberate UNVERIFIABLE (CLI unavailable) in a real pipeline, with sanitized logs.
4. Show that the pipeline cannot be changed by a pull request to weaken the guard: configure the protections in Section 9 and attempt to bypass them.
5. Record the CLI, Node.js and Azure DevOps Server versions used.

## References

- Microsoft Learn, "Use templates for security" (Azure Pipelines): <https://learn.microsoft.com/en-us/azure/devops/pipelines/security/templates>
- Microsoft Learn, "Define approvals and checks": <https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals>
- Microsoft Learn, "Branch policies and settings" (automatically included reviewers): <https://learn.microsoft.com/en-us/azure/devops/repos/git/branch-policies>
