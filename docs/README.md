# Chapter index

Each chapter is a verifiable engineering pattern with five elements: a problem statement, an implementation, a threat or failure model, executable tests and evidence.

"Status" is the maturity of the material **published in this repository**. At this stage only Chapters 8 and 14 have been published, with three supporting pages for the identity part. See the [verification matrix](../README.md#verification-matrix) for what that status does and does not cover.

| Part | Chapter | Status | Target |
|------|---------|--------|--------|
| I. Delivery architecture | 1. Environment models and the promotion contract | concept | v0.1 |
| | 2. Salesforce DX repository layout | concept | v0.2 |
| | 3. Git branching, pull requests and work items | concept | v0.2 |
| | 4. Release artifacts and the release manifest | concept | v0.2 |
| | 5. Hotfixes, scratch orgs and parallel releases | concept | v0.5 |
| II. Safe execution | 6. Self-hosted agents and restricted networks | concept | v0.2 |
| | 7. Salesforce CLI and JWT authentication | concept | v0.1 |
| | 8. [Org Guard](08-org-guard.md) | local-tested | v0.1 |
| | 9. Deployment validation and Apex tests | concept | v0.2 |
| III. Functional confidence | 10. Testing without a live org | concept | v0.1 |
| | 11. End-to-end tests for email and Cases | concept | v0.4 |
| | 12. Test data seeding | concept | v0.4 |
| IV. Identity and continuity | 13. SSO with an enterprise identity provider | concept | v0.3 |
| | 14. [SSO audit and Federation ID reconciliation](14-sso-audit-federation-id-reconciliation.md) | local-tested | v0.3 |
| | 15. Configuration backup and drift detection | concept | v0.3 |
| | 16. Post-refresh recovery runbook | concept | v0.3 |
| V. Operations and evidence | 17. Secrets, certificates and audit | concept | v0.1 |
| | 18. Failure-scenario catalog | concept | v0.4 |
| | 19. When not to build this yourself | concept | v0.5 |
| | 20. Complete example: pipeline and recovery | concept | v0.5 |

Chapter 14 is read-only, tested offline against a fake Salesforce CLI, and does not verify SSO. Supporting pages:

- [SSO audit workflow](sso-audit-workflow.md): how the audit is run and read. `local-tested`.
- [SSO continuity architecture](sso-continuity-architecture.md): the ten planned modules. Mostly design.
- [Post-refresh recovery architecture](sso-post-refresh-recovery-architecture.md): design only; no code modifies Salesforce.

Chapters and targets may change as evidence is gathered.
