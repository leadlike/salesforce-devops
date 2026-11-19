# SSO audit workflow

> **Maturity status: `local-tested`.** Every step below is implemented and tested **offline**, with a fake Salesforce CLI and fictional data. The commands that read a real org have **never been run against one**. A passing result is not proof that anyone can sign in.

This page describes how the pieces in `scripts/sso-continuity/` fit into one audit, who has to do what, and how to read the result. For the reconciliation rules and the input and output contracts, see [Chapter 14](14-sso-audit-federation-id-reconciliation.md).

## 1. What the workflow answers

For one org, at one moment: **does every approved person have exactly the approved Federation ID, on an active user, with no duplicates and no unexplained extra users, and does the org have a SAML configuration that actually maps on Federation ID?**

It does not answer whether the identity provider asserts those values, whether certificates are valid, or whether a person can sign in.

## 2. Roles and trust boundaries

| Role | Owns | Must not be able to change |
|------|------|----------------------------|
| Baseline owner | The approved list of `userKey` and Federation ID pairs | The policy, the pipeline definition |
| Policy owner | The org identifier and the correlation field | The baseline |
| Pipeline owner | The pipeline definition and the module version | The baseline, the policy |
| Reviewer | Independent review of any change to the three above | Nothing; reviews only |

The reason for the split is simple. A passing result is only as trustworthy as the baseline and the policy it was checked against. **If one unreviewed change can edit the baseline and the policy that interprets it, the audit proves nothing.** Keep the baseline and policy in a protected repository or store, pin their versions, and pin the policy digest with `--policy-sha256`. The same mechanisms described for Org Guard apply: [Chapter 8, Section 9](08-org-guard.md#9-protecting-the-guard-and-its-policy-from-untrusted-pull-requests).

The real baseline maps people to Federation IDs. **It must never be committed to a public repository.**

## 3. Prerequisites

1. **Decide where the correlation key lives.** The policy names one field: `EmployeeNumber`, or a custom field ending in `__c`. E-mail, username, name, alias and Federation ID fields are not accepted. The values in that field must be assigned and approved by people, outside this module.
2. **Produce the baseline** from an authoritative source, review it, and store it in the protected location.
3. **Write the policy** (fictional example: `fixtures/policy.example.json`): `orgKey`, `expectedOrgId`, the correlation field, and the user types in scope.
4. **Provide a Salesforce CLI session** for an integration user. See the permissions note below.
5. **Node.js 20 or 22** on the agent. No other dependency.

### Permissions: the "read-only" user is not minimal

The module only reads, but some of what it reads is administrative configuration. Salesforce's object reference states that `AuthProvider` is accessible only to users with the Customize Application and Manage AuthProviders permissions, and that `SamlSsoConfig` is accessible only to users with View Setup and Configuration, or with both Customize Application and Modify All Data. An integration user that can run `verify` end to end therefore holds powerful read access, and may also hold write capability depending on how its permissions were composed. Review it. A planned improvement is to split the Federation ID audit, which needs only user data, from the configuration inventory so that each can run with narrower permissions. Until then, `verify` fails closed (`E_CLI_FAILED`) if the user cannot read those objects.

## 4. Steps

| # | Step | Command | Purpose |
|---|------|---------|---------|
| 1 | Org Guard | `node org-guard.mjs --policy ... --target-org ALIAS` | Confirm this is the org you meant, before anything else |
| 2 | Verify | `node src/live-cli.mjs verify --policy P --baseline B --target-org ALIAS --policy-sha256 H` | Read the org and reconcile it with the baseline |
| 3 | Interpret | See Section 6 | Decide what each finding means |
| 4 | Record | Keep the output in a restricted location | Evidence |

`verify` itself repeats an org identity check (`SELECT Id FROM Organization` against the policy's `expectedOrgId`) before it reads any user or SSO data. That is a second line of defense and does not replace Org Guard.

Separate commands exist for review and replay:

| Command | Output | Use |
|---------|--------|-----|
| `live-cli.mjs snapshot` | A snapshot document on stdout; counts-only diagnostics on stderr | Capture a snapshot to a protected store for later review |
| `live-cli.mjs inventory` | Inventory of SAML configurations and Auth Providers; IdP URLs appear only as fingerprints | Compare configuration over time |
| `cli.mjs <baseline> <snapshot>` | The reconciliation result | Re-run the audit offline on a stored snapshot |

A snapshot contains Federation ID values. Treat it as sensitive and keep it out of build logs and public repositories.

## 5. Exit codes

| Code | Meaning | Pipeline behavior |
|------|---------|-------------------|
| 0 | Verified and nothing to review | Continue |
| 2 | Review required | Stop; a person decides |
| 3 | Unverifiable | Stop; the audit itself could not complete |

Only 0 is success. Do not pipe the output into another command, and do not mark the step as allowed to fail. Distinguish 2 from 3 operationally: 2 means "the org differs from the baseline", 3 means "the check is broken or the inputs are untrustworthy".

## 6. Reading the result

| Finding or warning | Meaning | Typical next step |
|--------------------|---------|-------------------|
| `MATCH` | The approved ID is present on an active user | None |
| `MISSING` | The user has no Federation ID | Investigate before any restoration is considered |
| `MISMATCH` | A different value is stored | Find out which side is right; do not overwrite blindly |
| `DUPLICATE_ACTUAL` | More than one user holds the same Federation ID | Treat as urgent: ambiguous sign-in |
| `INACTIVE` | The approved user is deactivated | Confirm that this is intended |
| `USER_NOT_FOUND` | No user carries the approved `userKey` | Check the baseline and the key field |
| `AMBIGUOUS` | A `userKey` or expected ID appears more than once | Fix the baseline or the key data first |
| `UNMANAGED` | A user exists that the baseline does not cover | Decide whether it should be approved |
| `uncorrelatedUsers` greater than 0 | Active users without a usable key | Give them keys or exclude their user type deliberately; they block a PASS |
| `NO_SAML_CONFIG_MAPS_ON_FEDERATION_ID` | No SAML configuration maps on Federation ID | The reconciliation may not be relevant to how people sign in; review the SSO design |

`evidence.ssoLoginVerified` is always `false`. It is there so that nobody reads a PASS as a login test.

## 7. Error codes

Error output is one line: `UNVERIFIABLE [CODE]: fixed message. No changes were made.` Messages never contain input values, CLI output or stack traces.

| Code | Cause |
|------|-------|
| `E_USAGE` | Wrong or unknown arguments |
| `E_POLICY`, `E_POLICY_PIN` | Invalid policy, or the file does not match its pinned digest |
| `E_TARGET_ORG` | The target org value contains unsafe characters |
| `E_CLI_UNAVAILABLE`, `E_CLI_TIMEOUT`, `E_CLI_FAILED`, `E_CLI_OUTPUT` | The Salesforce CLI could not be started, timed out, reported a failure, or returned something unexpected |
| `E_QUERY_INCOMPLETE` | `totalSize` disagreed with the records returned, or `done` was false |
| `E_ORG_ID_MISMATCH` | The org is not the one named in the policy |
| `E_ORG_MISMATCH` | The baseline and the policy name different orgs |
| `E_BASELINE_EMPTY`, `E_SCHEMA`, `E_SCHEMA_VERSION`, `E_INPUT_*`, `E_LIMIT_RECORDS`, `E_SNAPSHOT_INCOMPLETE` | The baseline or snapshot is invalid, too large or incomplete |
| `E_INTERNAL` | An unexpected error; report it |

## 8. What is and is not verified

| Claim | Status |
|-------|--------|
| Reconciliation, correlation, inventory and error handling behave as documented | **Verified offline.** Unit tests with fictional fixtures, in CI on Linux and Windows |
| Only `sf data query` of an allow-listed SELECT can be built, secrets are never selected, and the org is checked before data is read | **Verified offline.** Tests and a source scan |
| The shape of the real CLI's JSON output matches what the code expects | **Not verified.** Taken from documentation |
| The CLI returns every user in one call, or fails visibly | **Not verified.** The code requires `totalSize` to equal the record count and fails closed otherwise. Large orgs may therefore fail with `E_QUERY_INCOMPLETE` until pagination is verified |
| The queried fields exist and are readable in a real org | **Not verified.** Field names were checked against Salesforce documentation, not against an org |
| The pipeline examples work | **Not verified.** Valid YAML only |
| People can sign in | **Not verified, and out of scope** |
