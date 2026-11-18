# Salesforce DevOps & Identity Continuity Hub

A practical, vendor-neutral guide to building a Salesforce DevOps chain in an enterprise environment: **Git, CI/CD, SSO identity management, and recovery after sandbox refresh.**

It targets Salesforce architects, DevOps engineers, identity engineers and platform teams who work with self-hosted tooling (for example Azure DevOps Server), an enterprise identity provider, and network constraints.

> All examples use fictional environments. No real organization, tenant, user or credential appears in this repository.

## The four-level model

```
Sandbox (dev)  ->  QA  ->  UAT  ->  Production
   free work      automated   business    manual,
                  validation  validation  authorized
```

| Level | Purpose | Deployment |
|-------|---------|------------|
| Sandbox | Individual development | Developer-driven |
| QA | Integration, Apex and E2E tests | Automated (validate + deploy) |
| UAT | Business acceptance (Full copy) | Manual, approved |
| Production | Live operation | Manual, approved |

Every level maps to a Git branch and a Salesforce org. Promotion is always one step at a time.

## What the guide covers

1. Architecture for enterprise Salesforce DevOps
2. Salesforce DX repository layout
3. Git branching, pull requests and work items
4. Self-hosted agents (Azure DevOps Server)
5. Salesforce CLI and JWT authentication
6. Org Guard: preventing deployments to the wrong org
7. Deployment validation and Apex tests
8. End-to-end tests for email and Cases
9. SSO with an enterprise identity provider (SAML)
10. Federation ID management
11. Git-based configuration backup
12. Sandbox post-refresh recovery
13. Security: secrets, certificates, audit
14. Troubleshooting
15. A complete example pipeline and recovery procedure

See [docs/README.md](docs/README.md) for the chapter index and status.

## Honesty policy

Every chapter carries one of these statuses:

| Status | Meaning |
|--------|---------|
| `concept` | Designed, not yet built |
| `local-tested` | Works locally (for example offline unit tests) |
| `ci-validated` | Proven in a CI run on a real sandbox |
| `production-proven` | Used in production |

Nothing is presented as more mature than it is. At the start of this project, most chapters are `concept` or `local-tested`, and statuses will be upgraded as evidence is gathered.

## Contributing

Contributions are welcome: corrections, other CI systems, other identity providers. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE).
