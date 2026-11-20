import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseArgs } from '../src/live-cli.mjs';
import { validateSnapshot } from '../src/schema.mjs';
import { Unverifiable } from '../src/errors.mjs';
import { fakeSf, fixtureResponses, fixturePath, queryResponse } from '../testkit/fake-sf.mjs';
import { baseline, id } from '../testkit/builders.mjs';

const POLICY = fixturePath('policy.example.json');
const BASELINE = fixturePath('baseline.json');
const LIVE = fileURLToPath(new URL('../src/live-cli.mjs', import.meta.url));

function run(argv, { responses = fixtureResponses(), runner, readBaseline } = {}) {
  const sf = runner ?? fakeSf(responses);
  let stdout = '';
  let stderr = '';
  const code = main(argv, { runner: sf, readBaseline, out: (s) => { stdout += s; }, err: (s) => { stderr += s; } });
  return { code, stdout, stderr, calls: sf.calls ?? [] };
}
const verifyArgs = (extra = []) => ['verify', '--policy', POLICY, '--baseline', BASELINE, '--target-org', 'qa', ...extra];
const rec = (key, fid, active = true) => ({ EmployeeNumber: key, IsActive: active, FederationIdentifier: fid, UserType: 'Standard' });
const saml = (mapping) => queryResponse([{ DeveloperName: 'S', MasterLabel: 'S', IdentityMapping: mapping, IdentityLocation: 'SubjectNameId', OptionsUserProvisioning: false, Issuer: 'https://idp.example.invalid/i', LoginUrl: null }]);

test('argument parsing is strict', () => {
  const throwsUsage = (argv) => assert.throws(() => parseArgs(argv), (e) => e instanceof Unverifiable && e.code === 'E_USAGE');
  throwsUsage([]);
  throwsUsage(['unknown']);
  throwsUsage(['snapshot']);
  throwsUsage(['snapshot', '--policy', 'p']);
  throwsUsage(['snapshot', '--policy', 'p', '--target-org']);
  throwsUsage(['snapshot', '--policy', 'p', '--target-org', 'a', '--target-org', 'b']);
  throwsUsage(['snapshot', '--policy', 'p', '--target-org', 'a', '--baseline', 'b']); // baseline belongs to verify only
  throwsUsage(['snapshot', '--policy', 'p', '--target-org', 'a', '--force', 'x']);
  throwsUsage(['snapshot', 'positional', '--policy', 'p', '--target-org', 'a']);
  throwsUsage(['verify', '--policy', 'p', '--target-org', 'a']);
  assert.equal(parseArgs(['snapshot', '--policy', 'p', '--target-org', 'a']).command, 'snapshot');
});

test('snapshot: valid JSON on stdout, counts-only diagnostics on stderr, exit 0', () => {
  const r = run(['snapshot', '--policy', POLICY, '--target-org', 'qa']);
  assert.equal(r.code, 0);
  const snapshot = JSON.parse(r.stdout);
  assert.equal(validateSnapshot(snapshot).users.length, 4);
  assert.equal(snapshot.uncorrelatedUsers, 1);
  assert.match(r.stderr, /^diagnostics \(counts only\): \{.*\}\n$/);
});

test('snapshot output feeds the existing audit unchanged', async () => {
  const { reconcile } = await import('../src/reconcile.mjs');
  const snapshot = JSON.parse(run(['snapshot', '--policy', POLICY, '--target-org', 'qa']).stdout);
  const result = reconcile(JSON.parse(readFileSync(BASELINE, 'utf8')), snapshot);
  assert.equal(result.verdict, 'REVIEW_REQUIRED');
  assert.deepEqual(result.counts, { INACTIVE: 1, MATCH: 1, MISMATCH: 1, MISSING: 1 });
  assert.equal(result.uncorrelatedUsers, 1);
});

test('inventory: summary and fingerprints, exit 0', () => {
  const r = run(['inventory', '--policy', POLICY, '--target-org', 'qa']);
  assert.equal(r.code, 0);
  const inv = JSON.parse(r.stdout);
  assert.equal(inv.summary.federationIdMappedSamlConfigs, 1);
  assert.ok(!r.stdout.includes('example.invalid'));
});

test('verify with the fixtures requires review and states what it did not verify', () => {
  const r = run(verifyArgs());
  assert.equal(r.code, 2);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'REVIEW_REQUIRED');
  assert.equal(out.mode, 'READ_ONLY');
  assert.deepEqual(out.evidence, { source: 'sf data query', orgIdentityChecked: true, policyPinned: false, ssoLoginVerified: false });
  assert.deepEqual(out.audit.counts, { INACTIVE: 1, MATCH: 1, MISMATCH: 1, MISSING: 1 });
  assert.deepEqual(out.warnings, []);
});

test('verify passes only when the audit passes, nothing is uncorrelated, and SAML maps on Federation ID', () => {
  const responses = { ...fixtureResponses(), User: queryResponse([rec('a', 'fa'), rec('b', 'fb')]) };
  const r = run(verifyArgs(), { responses, readBaseline: () => baseline([id('a', 'fa'), id('b', 'fb')]) });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).verdict, 'PASS');
});

test('verify: a clean audit is NOT a pass when no SAML configuration maps on Federation ID', () => {
  for (const mapping of ['Username', null]) {
    const responses = { ...fixtureResponses(), User: queryResponse([rec('a', 'fa')]), SamlSsoConfig: saml(mapping) };
    const r = run(verifyArgs(), { responses, readBaseline: () => baseline([id('a', 'fa')]) });
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.audit.verdict, 'PASS');
    assert.deepEqual(out.warnings, ['NO_SAML_CONFIG_MAPS_ON_FEDERATION_ID']);
    assert.equal(out.verdict, 'REVIEW_REQUIRED');
  }
  const none = { ...fixtureResponses(), User: queryResponse([rec('a', 'fa')]), SamlSsoConfig: queryResponse([]) };
  assert.equal(run(verifyArgs(), { responses: none, readBaseline: () => baseline([id('a', 'fa')]) }).code, 2);
});

test('verify: an active user without a key blocks a pass', () => {
  const responses = { ...fixtureResponses(), User: queryResponse([rec('a', 'fa'), rec(null, null)]) };
  assert.equal(run(verifyArgs(), { responses, readBaseline: () => baseline([id('a', 'fa')]) }).code, 2);
});

test('the target org is checked BEFORE any user or SSO data is read', () => {
  const responses = { ...fixtureResponses(), Organization: queryResponse([{ Id: '00DOTHERORG0001' }]) };
  const r = run(verifyArgs(), { responses });
  assert.equal(r.code, 3);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /E_ORG_ID_MISMATCH/);
  assert.equal(r.calls.length, 1, 'only the organization query may run');
});

test('a baseline for another org is unverifiable', () => {
  const r = run(verifyArgs(), { readBaseline: () => baseline([id('a', 'fa')], 'another-org') });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /E_ORG_MISMATCH/);
});

test('every call is a read-only `sf data query` of an allow-listed SELECT', () => {
  const r = run(verifyArgs());
  assert.equal(r.calls.length, 4);
  const objects = [];
  for (const args of r.calls) {
    assert.deepEqual(args.slice(0, 2), ['data', 'query']);
    assert.equal(args[args.length - 1], '--json');
    const soql = args[args.indexOf('--query') + 1];
    assert.match(soql, /^SELECT [A-Za-z0-9_, ]+ FROM (User|Organization|SamlSsoConfig|AuthProvider)$/);
    assert.ok(!args.some((a) => /^(update|delete|create|upsert|deploy|import|apex|login|logout)$/i.test(a)));
    objects.push(/FROM (\w+)$/.exec(soql)[1]);
  }
  assert.deepEqual(objects, ['Organization', 'User', 'SamlSsoConfig', 'AuthProvider']);
});

test('incomplete, failed or unavailable CLI results are unverifiable with empty stdout', () => {
  const cases = {
    E_QUERY_INCOMPLETE: { ...fixtureResponses(), User: queryResponse([rec('a', 'f')], { totalSize: 9 }) },
    E_CLI_FAILED: { ...fixtureResponses(), User: () => ({ status: 1, stdout: '', timedOut: false }) },
    E_CLI_TIMEOUT: { ...fixtureResponses(), SamlSsoConfig: () => ({ status: null, stdout: '', timedOut: true }) },
    E_CLI_UNAVAILABLE: { ...fixtureResponses(), Organization: () => ({ status: null, stdout: '', timedOut: false, spawnError: 'ENOENT' }) },
    E_CLI_OUTPUT: { ...fixtureResponses(), AuthProvider: () => ({ status: 0, stdout: 'not json', timedOut: false }) },
  };
  for (const [code, responses] of Object.entries(cases)) {
    const r = run(verifyArgs(), { responses });
    assert.equal(r.code, 3, code);
    assert.equal(r.stdout, '', code);
    assert.match(r.stderr, new RegExp(`\\[${code}\\]`), code);
  }
});

test('a pinned policy is checked before any call to the CLI', () => {
  const digest = createHash('sha256').update(readFileSync(POLICY)).digest('hex');
  const ok = run(verifyArgs(['--policy-sha256', digest]));
  assert.equal(JSON.parse(ok.stdout).evidence.policyPinned, true);
  const bad = run(verifyArgs(['--policy-sha256', '0'.repeat(64)]));
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /E_POLICY_PIN/);
  assert.equal(bad.calls.length, 0);
});

test('invalid timeouts and target orgs are rejected before any call', () => {
  for (const t of ['0', '-1', '600001', 'abc', '1.5', '']) {
    const r = run(['snapshot', '--policy', POLICY, '--target-org', 'qa', '--timeout-ms', t]);
    assert.equal(r.code, 3, t);
    assert.equal(r.calls.length, 0);
  }
  for (const org of ['--json', 'a b', 'a;b', '']) {
    const r = run(['snapshot', '--policy', POLICY, '--target-org', org]);
    assert.equal(r.code, 3, org);
    assert.equal(r.calls.length, 0);
  }
});

test('unexpected internal errors exit 3 with a fixed message and no leaked detail', () => {
  const secret = 'SECRET-INTERNAL-DETAIL';
  const r = run(verifyArgs(), { runner: () => { throw new Error(`boom ${secret}`); } });
  assert.equal(r.code, 3);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /E_INTERNAL/);
  assert.ok(!r.stderr.includes(secret));
});

test('Federation ID values, issuer URLs and other raw fields never appear in any output', () => {
  const responses = {
    ...fixtureResponses(),
    User: queryResponse([rec('admin-001', 'SECRET-FID-AAA'), rec('admin-002', 'SECRET-FID-BBB'), { ...rec('x-9', 'SECRET-FID-CCC'), Email: 'SECRET@example.invalid' }]),
  };
  for (const argv of [['snapshot', '--policy', POLICY, '--target-org', 'qa'], ['inventory', '--policy', POLICY, '--target-org', 'qa'], verifyArgs()]) {
    const r = run(argv, { responses });
    if (argv[0] === 'snapshot') assert.ok(r.stdout.includes('SECRET-FID-AAA'), 'the snapshot is the one output that carries Federation IDs');
    else assert.ok(!r.stdout.includes('SECRET'), `${argv[0]} stdout`);
    assert.ok(!r.stderr.includes('SECRET'), `${argv[0]} stderr`);
    assert.ok(!r.stdout.includes('example.invalid') || argv[0] === 'snapshot');
  }
});

test('real process without the Salesforce CLI on PATH fails closed (exit 3, empty stdout)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'no-sf-'));
  try {
    const p = spawnSync(process.execPath, [LIVE, 'verify', '--policy', POLICY, '--baseline', BASELINE, '--target-org', 'qa'], { encoding: 'utf8', env: { PATH: empty } });
    assert.equal(p.status, 3);
    assert.equal(p.stdout, '');
    assert.match(p.stderr, /^UNVERIFIABLE \[E_CLI_(UNAVAILABLE|FAILED)\]: /);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('real process: usage errors exit 3', () => {
  for (const args of [[], ['nope'], ['snapshot']]) {
    const p = spawnSync(process.execPath, [LIVE, ...args], { encoding: 'utf8', env: { PATH: '' } });
    assert.equal(p.status, 3);
    assert.equal(p.stdout, '');
    assert.match(p.stderr, /E_USAGE/);
  }
});

test('source scan: only sf-runner can start a process, and nothing in src can write, call out or read secrets', () => {
  const dir = new URL('../src/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.includes('sf-runner.mjs') && files.includes('live-cli.mjs'));
  for (const file of files) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    const spawns = /node:child_process/.test(text);
    assert.equal(spawns, file === 'sf-runner.mjs', `${file}: child_process only in sf-runner.mjs`);
    assert.ok(!/node:(net|http|https|dgram|tls|dns|worker_threads)|\bfetch\(|writeFile|appendFile|createWriteStream|unlink|rmSync|renameSync|mkdirSync|process\.env/.test(text), `${file} must not write, call out or read the environment`);
  }
  const runner = readFileSync(new URL('sf-runner.mjs', dir), 'utf8');
  assert.ok(!/['"`](update|delete|create|upsert|deploy|import|apex|login|logout|auth)['"`]/i.test(runner), 'sf-runner must not name any mutating command');
  assert.equal((runner.match(/'data', 'query'/g) ?? []).length, 1, 'exactly one command shape');
});
