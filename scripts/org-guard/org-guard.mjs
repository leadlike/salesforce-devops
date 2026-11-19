#!/usr/bin/env node
// Org Guard: verify that a Salesforce CLI target is the org you intend to
// operate on, before any deployment, test run or data operation.
//
// Design rules:
//   * Fail closed. If a check cannot be completed, the result is not PASS.
//   * Pure evaluation. evaluate() performs no I/O and is fully testable offline.
//   * No secrets in output. Access tokens are never printed.
//
// Exit codes: 0 = PASS, 2 = BLOCKED (policy violation), 3 = UNVERIFIABLE
// (the guard could not complete verification or the configuration is invalid).

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const EXIT = Object.freeze({ PASS: 0, BLOCKED: 2, UNVERIFIABLE: 3 });

const ORG_ID = /^00D[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;
const TARGET_ALIAS = /^[A-Za-z0-9._@-]{1,100}$/;
const HOST = /^[a-z0-9.-]+$/;

/** Thrown for any condition that prevents a trustworthy verdict. */
export class Unverifiable extends Error {}

const fifteen = (id) => id.slice(0, 15); // 15-char IDs are case-sensitive and canonical

/** Validate the policy. Throws Unverifiable on any problem. */
export function validatePolicy(policy) {
  const bad = (m) => { throw new Unverifiable(`invalid policy: ${m}`); };
  if (!policy || typeof policy !== 'object') bad('policy must be an object');
  if (!ORG_ID.test(policy.expectedOrgId ?? '')) bad('expectedOrgId must be a 15 or 18 character org ID');
  if (!['sandbox', 'production'].includes(policy.environmentType)) bad('environmentType must be "sandbox" or "production"');
  if (typeof policy.expectedUsername !== 'string' || !policy.expectedUsername.includes('@')) bad('expectedUsername is required');
  if (!Array.isArray(policy.allowedInstanceHosts) || policy.allowedInstanceHosts.length === 0) bad('allowedInstanceHosts must be a non-empty array');
  for (const h of policy.allowedInstanceHosts) if (typeof h !== 'string' || !HOST.test(h)) bad(`invalid host "${h}"`);
  const deny = policy.denyOrgIds ?? [];
  if (!Array.isArray(deny)) bad('denyOrgIds must be an array');
  for (const d of deny) if (!ORG_ID.test(d)) bad(`invalid deny-list entry "${d}"`);
  if (deny.some((d) => fifteen(d) === fifteen(policy.expectedOrgId))) bad('expectedOrgId is also on the deny list');
  return { ...policy, denyOrgIds: deny };
}

/** Extract and validate the fields we rely on from `sf org display --json`. */
function readDisplay(display) {
  const r = display?.result;
  if (display?.status !== 0 || !r || typeof r !== 'object') throw new Unverifiable('org display did not return a successful result');
  for (const f of ['id', 'username', 'instanceUrl']) {
    if (typeof r[f] !== 'string' || r[f] === '') throw new Unverifiable(`org display result is missing "${f}"`);
  }
  if (!ORG_ID.test(r.id)) throw new Unverifiable('org display returned a malformed org ID');
  let host;
  try { host = new URL(r.instanceUrl).hostname.toLowerCase(); }
  catch { throw new Unverifiable('org display returned a malformed instanceUrl'); }
  return { id: r.id, username: r.username, host };
}

/** Extract the single Organization record from `sf data query --json`. */
function readOrganization(org) {
  const recs = org?.result?.records;
  if (org?.status !== 0 || !Array.isArray(recs)) throw new Unverifiable('organization query did not return a successful result');
  if (recs.length !== 1) throw new Unverifiable(`organization query returned ${recs.length} records, expected exactly 1`);
  const rec = recs[0];
  if (typeof rec.Id !== 'string' || !ORG_ID.test(rec.Id)) throw new Unverifiable('organization record has a malformed Id');
  if (typeof rec.IsSandbox !== 'boolean') throw new Unverifiable('organization record is missing a boolean IsSandbox');
  return { id: rec.Id, isSandbox: rec.IsSandbox };
}

/**
 * Evaluate the checks. Pure function: no I/O.
 * Returns { code, verdict, checks: [{ name, ok, detail }] }.
 */
export function evaluate({ policy: rawPolicy, display, organization }) {
  let policy, d, o;
  try {
    policy = validatePolicy(rawPolicy);
    d = readDisplay(display);
    o = readOrganization(organization);
  } catch (e) {
    if (!(e instanceof Unverifiable)) throw e;
    return { code: EXIT.UNVERIFIABLE, verdict: 'UNVERIFIABLE', checks: [{ name: 'verification', ok: false, detail: e.message }] };
  }

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // The two sources must describe the same org, otherwise the data is inconsistent.
  if (fifteen(d.id) !== fifteen(o.id)) {
    return { code: EXIT.UNVERIFIABLE, verdict: 'UNVERIFIABLE', checks: [{ name: 'consistency', ok: false, detail: 'org display and organization query describe different orgs' }] };
  }

  const denied = policy.denyOrgIds.some((x) => fifteen(x) === fifteen(d.id));
  add('deny-list', !denied, denied ? 'target org is on the deny list' : 'target org is not on the deny list');
  add('org-id', fifteen(d.id) === fifteen(policy.expectedOrgId), `expected ${fifteen(policy.expectedOrgId)}, found ${fifteen(d.id)}`);
  const actualType = o.isSandbox ? 'sandbox' : 'production';
  add('environment-type', actualType === policy.environmentType, `expected ${policy.environmentType}, found ${actualType}`);
  const hosts = policy.allowedInstanceHosts.map((h) => h.toLowerCase());
  add('instance-host', hosts.includes(d.host), `host ${d.host} ${hosts.includes(d.host) ? 'is' : 'is not'} allowed`);
  add('username', d.username.toLowerCase() === policy.expectedUsername.toLowerCase(), `expected ${policy.expectedUsername}, found ${d.username}`);

  const ok = checks.every((c) => c.ok);
  return { code: ok ? EXIT.PASS : EXIT.BLOCKED, verdict: ok ? 'PASS' : 'BLOCKED', checks };
}

/** Default runner: executes the Salesforce CLI with a hard timeout. */
export function cliRunner(args, timeoutMs) {
  const r = spawnSync('sf', args, { encoding: 'utf8', timeout: timeoutMs, shell: process.platform === 'win32' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error?.code === 'ETIMEDOUT', spawnError: r.error && r.error.code !== 'ETIMEDOUT' ? r.error.code ?? 'UNKNOWN' : undefined };
}

function runJson(runner, args, timeoutMs, label) {
  const r = runner(args, timeoutMs);
  if (r.timedOut) throw new Unverifiable(`${label}: timed out after ${timeoutMs} ms`);
  if (r.spawnError) throw new Unverifiable(`${label}: could not run the Salesforce CLI (${r.spawnError}); is "sf" installed and on PATH?`);
  if (r.status !== 0 && !r.stdout) throw new Unverifiable(`${label}: CLI exited with status ${r.status}`);
  try { return JSON.parse(r.stdout); }
  catch { throw new Unverifiable(`${label}: CLI output is not valid JSON`); }
}

/** Collect live data through the CLI. Throws Unverifiable on any failure. */
export function collect({ runner = cliRunner, targetOrg, timeoutMs = 60000 }) {
  if (!TARGET_ALIAS.test(targetOrg ?? '')) throw new Unverifiable('target org alias or username contains unsupported characters');
  const display = runJson(runner, ['org', 'display', '--target-org', targetOrg, '--json'], timeoutMs, 'org display');
  const organization = runJson(runner, ['data', 'query', '--target-org', targetOrg, '--query', 'SELECT Id, IsSandbox FROM Organization', '--json'], timeoutMs, 'organization query');
  return { display, organization };
}

export function formatReport(result, mode) {
  const lines = [`MODE: ${mode}`];
  for (const c of result.checks) lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  lines.push(`RESULT: ${result.verdict}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline-fixtures') out.offline = true;
    else if (['--policy', '--target-org', '--display-file', '--organization-file', '--timeout-ms'].includes(a)) out[a.slice(2)] = argv[++i];
    else throw new Unverifiable(`unknown argument "${a}"`);
  }
  return out;
}

export function main(argv, { runner = cliRunner, log = console.log } = {}) {
  try {
    const args = parseArgs(argv);
    if (!args.policy) throw new Unverifiable('--policy is required');
    let policy;
    try { policy = JSON.parse(readFileSync(args.policy, 'utf8')); }
    catch { throw new Unverifiable('policy file is unreadable or not valid JSON'); }
    let data, mode;
    if (args.offline) {
      mode = 'offline-fixture (NOT a live verification)';
      if (!args['display-file'] || !args['organization-file']) throw new Unverifiable('offline mode needs --display-file and --organization-file');
      try {
        data = { display: JSON.parse(readFileSync(args['display-file'], 'utf8')), organization: JSON.parse(readFileSync(args['organization-file'], 'utf8')) };
      } catch { throw new Unverifiable('fixture files are unreadable or not valid JSON'); }
    } else {
      mode = 'live';
      data = collect({ runner, targetOrg: args['target-org'], timeoutMs: Number(args['timeout-ms'] ?? 60000) });
    }
    const result = evaluate({ policy, ...data });
    log(formatReport(result, mode));
    return result.code;
  } catch (e) {
    if (!(e instanceof Unverifiable)) throw e;
    log(`MODE: n/a\nFAIL  verification: ${e.message}\nRESULT: UNVERIFIABLE`);
    return EXIT.UNVERIFIABLE;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
