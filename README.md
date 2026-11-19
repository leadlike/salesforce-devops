# Salesforce Environment Continuity

**Safe delivery, identity recovery and post-refresh verification for Salesforce teams running self-hosted CI/CD.**

Most Salesforce DevOps material explains how to deploy. This repository focuses on what comes after the pipeline is written:

- How do we make sure an operation never reaches the wrong org?
- How do we recover a sandbox after a refresh, including its identity and SSO configuration, without creating a security hole?
- How do we prove what was checked, what changed and who authorized it?

It is a vendor-neutral reference for architects, DevOps engineers and identity engineers working in constrained enterprise environments: self-hosted agents (for example Azure DevOps Server), an enterprise identity provider, and restricted networks.

> **Status: early.** This repository is being built incrementally. Nothing is presented as more mature than the evidence behind it. See the [maturity policy](#maturity-policy).

## Design principles

1. **Promote a release, not a branch.** What is validated is what is promoted: the same artifact, identified by commit SHA, API version and evidence.
2. **Fail closed.** When a check cannot be completed, the operation stops.
3. **Identity changes are security operations.** Restoring a Federation ID changes who can sign in as a user. It is separately authorized and never part of a normal deployment stage.
4. **Git is not an identity vault.** Git holds scripts, schemas and non-sensitive policy. Individual identity mappings belong in a protected store.
5. **Evidence over assertion.** The goal is for every pattern to be published with tests and recorded output. Until that evidence exists, the pattern is labeled accordingly.

These principles describe the intended direction of the guide. They are not claims about what is already implemented.

## Reference architecture, not mandatory architecture

Everything in this guide is a **reference**: a worked example to adapt, compare and challenge. Nothing here is a required architecture, and the right design depends on your release risk, team topology, data needs, integrations and organizational controls.

The worked example uses four levels as an illustration only.

```
Developer Environment  ->  Integration / QA  ->  Business UAT  ->  Production
   individual work         automated checks      acceptance        manual, authorized
```

The important design decision is not the number of environments. It is the **promotion contract** between them. Hotfixes, scratch orgs, package-based development and parallel releases are documented as explicit exceptions.

## Structure of the guide

| Part | Question it answers |
|------|---------------------|
| I. Delivery architecture | What exactly are we promoting? |
| II. Safe execution | How do we prevent unsafe operations? |
| III. Functional confidence | How do we know the change works? |
| IV. Identity and continuity | How do we recover a trustworthy environment? |
| V. Operations and evidence | How do we operate the system and prove it? |

The full chapter list and status is in [docs/README.md](docs/README.md).

## Roadmap (planned, not delivered)

The scope below is planned. No release has been tagged yet. Material that already exists in the repository, and how far it has been verified, is listed in the [verification matrix](#verification-matrix).

| Release | Planned scope |
|---------|-------|
| **v0.1 – Safe Salesforce Deployment Foundations** | README and architecture, Org Guard implementation, offline test suite (no Salesforce credentials needed), sample CI configuration, threat model, maturity and evidence matrix, one complete troubleshooting example |
| v0.2 | Fictional Salesforce DX project, deployment validation, release manifest |
| v0.3 | Identity reconciliation example (an offline version is already published as Chapter 14), SSO dependency matrix, post-refresh runbook |
| v0.4 | Documented sandbox rehearsal and failure-scenario catalog |
| v0.5 | GitHub Actions and GitLab equivalents, tool comparison |

Dates are not promised. Releases ship when their evidence exists.

## Maturity policy

Every pattern carries one of these labels.

| Label | Meaning |
|-------|---------|
| `concept` | Designed, not yet built |
| `local-tested` | Passes offline tests, run locally and, where stated, in a hosted CI |
| `ci-validated` | Proven in a CI pipeline against a real sandbox |
| `production-proven` | Used in production |

Offline tests that run in a hosted CI do **not** make a pattern `ci-validated`. That label requires a real Salesforce org and the target pipeline.

Simulated results are never presented as results from a real Salesforce org.

### Verification matrix

Each chapter reports independent kinds of verification instead of one label. Chapters 8 and 14 are the only ones with an implementation so far.

| Verification | Chapter 8: Org Guard | Chapter 14: Federation ID reconciliation | Evidence |
|--------------|----------------------|------------------------------------------|----------|
| Offline unit tests validated in CI | **Verified.** 50 of 50 on GitHub-hosted runners (Linux and Windows, Node.js 20 and 22) | **Verified.** 55 of 55 on the same four environments | [Chapter 8 run](https://github.com/leadlike/salesforce-devops/actions/runs/44446574364); Chapter 14: [Actions run on `main`](https://github.com/leadlike/salesforce-devops/actions/runs/44461346263) |
| Salesforce CLI integration | **Not yet verified.** No real `sf` has been executed | **Not yet verified.** No snapshot has been produced from a real org | None |
| Azure DevOps Server integration | **Not yet verified.** Example checked only as valid YAML | **Not yet verified.** Example checked only as valid YAML | None |
| GitLab CI integration | Not applicable | **Not yet verified.** Example checked only as valid YAML | None |
| Live Salesforce run | **Not yet verified.** Nothing has run against a Salesforce org | **Not yet verified.** Nothing has run against a Salesforce org | None |
| Actual SSO login verification | Not applicable | **Not yet verified.** No user has signed in through an identity provider | None |
| Post-refresh recovery | Not applicable | **Not yet verified.** No sandbox has been refreshed and recovered | None |

Both chapters therefore stay at `local-tested`. Reconciliation compares approved Federation IDs with a snapshot of users. It is **not** SSO validation.

## When not to build this yourself

Salesforce-native tooling, open-source projects and commercial platforms already cover large parts of Salesforce delivery. A chapter will compare custom automation with those options using transparent criteria: deployment complexity, identity requirements, network restrictions, licensing, ownership and maintenance burden. Adopting an existing tool is often the better choice.

## About the examples

All examples are fictional. No real organization, tenant, user, domain or credential appears in this repository. Implementation and documentation are assisted by AI coding agents. The architecture, security decisions and validation remain the author's responsibility, and validation evidence is intended to be published alongside the code.

## Contributing

Corrections, additional CI systems and identity-provider examples are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE).
