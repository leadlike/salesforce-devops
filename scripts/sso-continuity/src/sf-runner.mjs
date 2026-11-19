// The single place that starts the Salesforce CLI.
//
// Only one command shape exists: `sf data query --target-org <alias> --query <SOQL> --json`.
// The query must pass the read-only gate in queries.mjs. No other `sf` subcommand can
// be built from this module, so there is no way to create, update, delete or deploy.
//
// CLI stderr and raw CLI output are never printed or included in error messages,
// because they can contain account details.
//
// The Salesforce CLI output shape used here (status, result.records, result.totalSize)
// comes from documentation. It has NOT been verified against a real CLI in this
// repository.

import { spawnSync } from 'node:child_process';
import { Unverifiable } from './errors.mjs';
import { assertReadOnlyQuery } from './queries.mjs';
import { validateTargetOrg } from './policy.mjs';
import { DEFAULT_LIMITS } from './limits.mjs';

const WIN_SAFE_ARG = /^[A-Za-z0-9._@:=,/ -]+$/;
const WIN_NO_QUOTE = /^[A-Za-z0-9._@-]+$/;

/** Build one command line for cmd.exe. Refuses any argument that would need escaping. */
export function windowsCommandLine(command, args) {
  const parts = [command];
  for (const a of args) {
    if (typeof a !== 'string' || !WIN_SAFE_ARG.test(a)) throw new Unverifiable('E_CLI_FAILED', 'an argument cannot be passed safely on Windows');
    parts.push(WIN_NO_QUOTE.test(a) ? a : `"${a}"`);
  }
  return parts.join(' ');
}

/** Describe how the CLI is started on a platform. Pure, so it is testable everywhere. */
export function spawnPlan(args, platform = process.platform) {
  return platform === 'win32'
    ? { command: windowsCommandLine('sf', args), argv: undefined, shell: true }
    : { command: 'sf', argv: args, shell: false };
}

/** Build the argument vector. The only command shape this module can produce. */
export function queryArgs(targetOrg, soql) {
  return ['data', 'query', '--target-org', validateTargetOrg(targetOrg), '--query', assertReadOnlyQuery(soql), '--json'];
}

/** Default runner: executes the Salesforce CLI with a hard timeout and an output cap. */
export function cliRunner(args, timeoutMs) {
  const plan = spawnPlan(args);
  const options = { encoding: 'utf8', timeout: timeoutMs, shell: plan.shell, windowsHide: true, maxBuffer: DEFAULT_LIMITS.maxFileBytes };
  const r = plan.argv ? spawnSync(plan.command, plan.argv, options) : spawnSync(plan.command, options);
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    timedOut: r.error?.code === 'ETIMEDOUT',
    spawnError: r.error && r.error.code !== 'ETIMEDOUT' ? (r.error.code ?? 'UNKNOWN') : undefined,
  };
}

/**
 * Run one read-only query and return its records.
 * Fails closed unless the result is complete: status 0, a records array, a totalSize
 * equal to the number of records, and `done` not false.
 */
export function runQuery({ runner = cliRunner, targetOrg, soql, timeoutMs = 60000 }) {
  const args = queryArgs(targetOrg, soql);
  const r = runner(args, timeoutMs);
  if (r.timedOut) throw new Unverifiable('E_CLI_TIMEOUT', 'the Salesforce CLI timed out');
  if (r.spawnError) throw new Unverifiable('E_CLI_UNAVAILABLE', 'the Salesforce CLI could not be started; is "sf" installed and on PATH?');
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    throw new Unverifiable(r.status === 0 ? 'E_CLI_OUTPUT' : 'E_CLI_FAILED', r.status === 0 ? 'the Salesforce CLI output is not valid JSON' : 'the Salesforce CLI failed');
  }
  if (r.status !== 0 || doc === null || typeof doc !== 'object' || doc.status !== 0) throw new Unverifiable('E_CLI_FAILED', 'the Salesforce CLI reported a failure');
  const result = doc.result;
  if (result === null || typeof result !== 'object' || !Array.isArray(result.records)) throw new Unverifiable('E_CLI_OUTPUT', 'the Salesforce CLI result has no records array');
  if (!Number.isSafeInteger(result.totalSize) || result.totalSize !== result.records.length || result.done === false) {
    throw new Unverifiable('E_QUERY_INCOMPLETE', 'the query result is incomplete');
  }
  for (const rec of result.records) {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) throw new Unverifiable('E_CLI_OUTPUT', 'the Salesforce CLI returned a malformed record');
  }
  return result.records;
}
