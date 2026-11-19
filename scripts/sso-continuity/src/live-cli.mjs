#!/usr/bin/env node
// Read-only live commands. They use the Salesforce CLI to READ an org.
//
//   node src/live-cli.mjs snapshot  --policy P --target-org ALIAS [--policy-sha256 H] [--timeout-ms N]
//   node src/live-cli.mjs inventory --policy P --target-org ALIAS [--policy-sha256 H] [--timeout-ms N]
//   node src/live-cli.mjs verify    --policy P --baseline B --target-org ALIAS [--policy-sha256 H] [--timeout-ms N]
//
// Exit codes: 0 = verified and nothing to review, 2 = review required, 3 = unverifiable.
// Only 0 is success. `snapshot` and `inventory` exit 0 when the data was collected.
//
// Nothing here writes to Salesforce. The only CLI command that can be built is
// `sf data query` with a SELECT from the allow list in queries.mjs.
// This path has NOT been run against a real org in this repository.

import { pathToFileURL } from 'node:url';
import { Unverifiable } from './errors.mjs';
import { EXIT } from './cli.mjs';
import { readJsonFile } from './json-input.mjs';
import { loadPolicy, validateTargetOrg } from './policy.mjs';
import { organizationQuery, usersQuery, samlConfigQuery, authProviderQuery } from './queries.mjs';
import { cliRunner, runQuery } from './sf-runner.mjs';
import { buildSnapshot, verifyOrganization } from './snapshot.mjs';
import { buildInventory } from './inventory.mjs';
import { reconcile } from './reconcile.mjs';

const COMMON = ['policy', 'policy-sha256', 'target-org', 'timeout-ms'];
const FLAGS = { snapshot: COMMON, inventory: COMMON, verify: [...COMMON, 'baseline'] };
const REQUIRED = { snapshot: ['policy', 'target-org'], inventory: ['policy', 'target-org'], verify: ['policy', 'target-org', 'baseline'] };

const usage = (message) => new Unverifiable('E_USAGE', message);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(FLAGS, command ?? '')) throw usage('usage: live-cli <snapshot|inventory|verify> --policy P --target-org ALIAS [...]');
  const args = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (typeof flag !== 'string' || !flag.startsWith('--') || !FLAGS[command].includes(flag.slice(2))) throw usage('unsupported option');
    const name = flag.slice(2);
    if (Object.hasOwn(args, name)) throw usage('an option was given twice');
    const value = rest[i + 1];
    if (value === undefined) throw usage('an option has no value');
    args[name] = value;
  }
  for (const name of REQUIRED[command]) if (!Object.hasOwn(args, name)) throw usage('a required option is missing');
  return { command, args };
}

function parseTimeout(value) {
  if (value === undefined) return 60000;
  if (!/^[0-9]{1,7}$/.test(value) || Number(value) < 1 || Number(value) > 600000) throw usage('--timeout-ms must be an integer between 1 and 600000');
  return Number(value);
}

/** Read the org, in a fixed order: identity first, then data. */
export function collect({ runner, targetOrg, policy, timeoutMs, want }) {
  const q = (soql) => runQuery({ runner, targetOrg, soql, timeoutMs });
  verifyOrganization(policy, q(organizationQuery()));
  const out = {};
  if (want.users) out.users = q(usersQuery(policy.correlationField));
  if (want.sso) { out.saml = q(samlConfigQuery()); out.authProviders = q(authProviderQuery()); }
  return out;
}

export function main(argv, { runner = cliRunner, readBaseline = readJsonFile, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  try {
    const { command, args } = parseArgs(argv);
    const timeoutMs = parseTimeout(args['timeout-ms']);
    const targetOrg = validateTargetOrg(args['target-org']);
    const { policy } = loadPolicy(args.policy, args['policy-sha256']);
    const print = (value) => out(`${JSON.stringify(value, null, 2)}\n`);

    if (command === 'snapshot') {
      const { users } = collect({ runner, targetOrg, policy, timeoutMs, want: { users: true } });
      const { snapshot, diagnostics } = buildSnapshot(policy, users);
      print(snapshot);
      err(`diagnostics (counts only): ${JSON.stringify(diagnostics)}\n`);
      return EXIT.PASS;
    }
    if (command === 'inventory') {
      const { saml, authProviders } = collect({ runner, targetOrg, policy, timeoutMs, want: { sso: true } });
      print(buildInventory(policy.orgKey, saml, authProviders));
      return EXIT.PASS;
    }

    // verify
    const baseline = readBaseline(args.baseline);
    const { users, saml, authProviders } = collect({ runner, targetOrg, policy, timeoutMs, want: { users: true, sso: true } });
    const { snapshot, diagnostics } = buildSnapshot(policy, users);
    const audit = reconcile(baseline, snapshot);
    const inventory = buildInventory(policy.orgKey, saml, authProviders);
    const warnings = [];
    // Reconciling Federation IDs only means something if SAML actually maps on them.
    if (inventory.summary.federationIdMappedSamlConfigs === 0) warnings.push('NO_SAML_CONFIG_MAPS_ON_FEDERATION_ID');
    const verdict = audit.verdict === 'PASS' && warnings.length === 0 ? 'PASS' : 'REVIEW_REQUIRED';
    print({
      schemaVersion: 1,
      orgKey: policy.orgKey,
      mode: 'READ_ONLY',
      verdict,
      warnings,
      evidence: {
        source: 'sf data query',
        orgIdentityChecked: true,
        policyPinned: args['policy-sha256'] !== undefined,
        ssoLoginVerified: false,
      },
      audit,
      inventory: inventory.summary,
      diagnostics,
    });
    return verdict === 'PASS' ? EXIT.PASS : EXIT.REVIEW_REQUIRED;
  } catch (error) {
    const known = error instanceof Unverifiable;
    err(`UNVERIFIABLE [${known ? error.code : 'E_INTERNAL'}]: ${known ? error.message : 'unexpected internal error'}. No changes were made.\n`);
    return EXIT.UNVERIFIABLE;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
