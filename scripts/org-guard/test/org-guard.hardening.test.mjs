// Additional tests added to cover specific, identified risks:
//   * exit codes (a BLOCKED or UNVERIFIABLE verdict must never exit with 0)
//   * secret leakage through normal output and error handling
//   * policy tampering (pinned SHA-256 digest)
//   * Windows command-line construction and path handling
//   * invalid timeout values
// The original 29 baseline tests live in org-guard.test.mjs and are unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, main, redact, windowsCommandLine, spawnPlan, collect, EXIT, Unverifiable } from '../org-guard.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const GUARD = here('../org-guard.mjs');
const POLICY = here('../policy.example.json');
const ex = (f) => here(`../examples/${f}`);
const load = (p) => JSON.parse(readFileSync(here(p), 'utf8'));
const policy = () => load('../policy.example.json');
const display = () => load('../examples/display-qa.json');
const organization = () => load('../examples/organization-qa.json');

const offlineArgs = (d, o, extra = []) => ['--policy', POLICY, '--offline-fixtures', '--display-file', ex(d), '--organization-file', ex(o), ...extra];
const runCli = (args, env) => spawnSync(process.execPath, [GUARD, ...args], { encoding: 'utf8', env: env ?? process.env });

// Run main() while capturing everything written through console.log and stdout.
function capture(fn) {
  const out = []; const realLog = console.log; const realWrite = process.stdout.write;
  console.log = (...a) => out.push(a.join(' '));
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  try { fn((s) => out.push(s)); } finally { console.log = realLog; process.stdout.write = realWrite; }
  return out.join('\n');
}

// --- Exit codes: real processes ---------------------------------------------
test('exit codes: the real process exits 0 on PASS, 2 on BLOCKED, 3 on UNVERIFIABLE', () => {
  assert.equal(runCli(offlineArgs('display-qa.json', 'organization-qa.json')).status, 0);
  assert.equal(runCli(offlineArgs('display-production.json', 'organization-production.json')).status, 2);
  assert.equal(runCli([]).status, 3);
  assert.equal(runCli(['--bogus']).status, 3);
  assert.equal(runCli(['--policy', join(tmpdir(), 'does-not-exist.json'), '--target-org', 'qa']).status, 3);
  assert.equal(runCli(offlineArgs('display-qa.json', 'does-not-exist.json')).status, 3);
});

test('exit codes: only PASS exits with 0, and blocked or unverifiable never do', () => {
  assert.equal(EXIT.PASS, 0);
  assert.ok(EXIT.BLOCKED > 0 && EXIT.UNVERIFIABLE > 0);
  assert.notEqual(EXIT.BLOCKED, EXIT.UNVERIFIABLE);
});

test('exit codes: live mode without the Salesforce CLI exits non-zero', () => {
  // An empty PATH guarantees that "sf" cannot be found, on every platform.
  const r = runCli(['--policy', POLICY, '--target-org', 'qa'], { ...process.env, PATH: '', Path: '' });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /RESULT: UNVERIFIABLE/);
});

test('exit codes: invariant over many mutated inputs (verdict and code always agree)', () => {
  const mut = (fn) => { const d = display(); const o = organization(); const p = policy(); fn(d, o, p); return { policy: p, display: d, organization: o }; };
  const cases = [
    mut(() => {}),
    mut((d) => { d.result.id = '00D000000000XXXAAA'; }),
    mut((d, o) => { o.result.records[0].IsSandbox = false; }),
    mut((d) => { d.result.instanceUrl = 'https://x.my.salesforce.com'; }),
    mut((d) => { d.result.username = 'other@example.com'; }),
    mut((d) => { delete d.result; }),
    mut((d) => { d.status = 1; }),
    mut((d, o) => { o.result.records = []; }),
    mut((d, o) => { o.result.records[0].IsSandbox = null; }),
    mut((d, o, p) => { p.expectedOrgId = ''; }),
    mut((d, o, p) => { p.allowedInstanceHosts = 'not-an-array'; }),
    mut((d, o, p) => { p.environmentType = 'production'; }),
    { policy: policy(), display: undefined, organization: organization() },
    { policy: policy(), display: display(), organization: null },
    { policy: undefined, display: display(), organization: organization() },
  ];
  for (const c of cases) {
    const r = evaluate(c);
    assert.ok([EXIT.PASS, EXIT.BLOCKED, EXIT.UNVERIFIABLE].includes(r.code));
    assert.equal(r.verdict === 'PASS', r.code === 0, `verdict ${r.verdict} with code ${r.code}`);
    assert.equal(r.verdict === 'BLOCKED', r.code === 2);
    assert.equal(r.verdict === 'UNVERIFIABLE', r.code === 3);
  }
});

test('exit codes: an unexpected internal error is UNVERIFIABLE, prints no message and no stack', () => {
  const secret = 'SECRET-IN-ERROR-MESSAGE-123456';
  const runner = () => { throw new TypeError(`boom ${secret}`); };
  let code;
  const output = capture((log) => { code = main(['--policy', POLICY, '--target-org', 'qa'], { runner, log }); });
  assert.equal(code, EXIT.UNVERIFIABLE);
  assert.match(output, /unexpected internal error/);
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes('TypeError'));
  assert.ok(!/\bat .*\.mjs/.test(output), 'no stack trace');
});

// --- Secret leakage ----------------------------------------------------------
const TOKEN = '00D000000000QA1!AQEAQsecretSESSIONtokenValue.1234567890';

test('secrets: a failing CLI response that contains a token is never echoed', () => {
  const runner = (args) => ({
    status: 1,
    stdout: JSON.stringify({ status: 1, name: 'Error', message: `Session expired ${TOKEN}`, result: { accessToken: TOKEN } }),
    stderr: `fatal: ${TOKEN}`,
    timedOut: false,
  });
  let code;
  const output = capture((log) => { code = main(['--policy', POLICY, '--target-org', 'qa'], { runner, log }); });
  assert.equal(code, EXIT.UNVERIFIABLE);
  assert.ok(!output.includes('secretSESSION'));
  assert.ok(!output.includes(TOKEN));
});

test('secrets: the known access token is masked even if it appears in a printed field', () => {
  // Force the token into the "username" detail line, which is printed in the report.
  const d = display(); d.result.accessToken = 'known-token-value-ABC123'; d.result.username = 'known-token-value-ABC123@example.com';
  const dir = mkdtempSync(join(tmpdir(), 'og-'));
  try {
    const df = join(dir, 'd.json'); writeFileSync(df, JSON.stringify(d));
    let code;
    const output = capture((log) => { code = main(['--policy', POLICY, '--offline-fixtures', '--display-file', df, '--organization-file', ex('organization-qa.json')], { log }); });
    assert.equal(code, EXIT.BLOCKED);
    assert.match(output, /username/);
    assert.ok(!output.includes('known-token-value-ABC123'));
    assert.match(output, /\[REDACTED\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('secrets: redact() masks session ID shaped strings and known values', () => {
  assert.equal(redact(`x ${TOKEN} y`), 'x [REDACTED] y');
  assert.equal(redact('abc supersecretvalue def', ['supersecretvalue']), 'abc [REDACTED] def');
  assert.equal(redact('short', ['abc']), 'short', 'values shorter than 8 characters are ignored to avoid masking ordinary text');
});

test('secrets: arguments are not echoed in error output', () => {
  let code;
  const output = capture((log) => { code = main(['--password=hunter2-should-not-appear'], { log }); });
  assert.equal(code, EXIT.UNVERIFIABLE);
  assert.ok(!output.includes('hunter2'));
});

test('secrets: policy values are not echoed in validation errors', () => {
  const p = policy(); p.allowedInstanceHosts = ['https://hunter2-secret/'];
  const r = evaluate({ policy: p, display: display(), organization: organization() });
  assert.equal(r.code, EXIT.UNVERIFIABLE);
  assert.ok(!JSON.stringify(r).includes('hunter2'));
});

test('secrets: stderr of the CLI is never printed', () => {
  const runner = () => ({ status: 1, stdout: '', stderr: 'PRIVATE-STDERR-CONTENT', timedOut: false });
  const output = capture((log) => { main(['--policy', POLICY, '--target-org', 'qa'], { runner, log }); });
  assert.ok(!output.includes('PRIVATE-STDERR-CONTENT'));
});

// --- Policy tampering (pinned digest) -----------------------------------------
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

test('policy pin: a matching digest allows the check to run', () => {
  const pin = sha256(readFileSync(POLICY));
  assert.equal(runCli(offlineArgs('display-qa.json', 'organization-qa.json', ['--policy-sha256', pin])).status, 0);
  assert.equal(runCli(offlineArgs('display-qa.json', 'organization-qa.json', ['--policy-sha256', pin.toUpperCase()])).status, 0);
});

test('policy pin: a modified policy is rejected even though it would otherwise PASS', () => {
  const pin = sha256(readFileSync(POLICY)); // the digest that an administrator approved
  const dir = mkdtempSync(join(tmpdir(), 'og-'));
  try {
    // An untrusted change re-targets the policy at production. The fixtures are production.
    const evil = { ...policy(), expectedOrgId: '00D000000000PRDAAA', environmentType: 'production', expectedUsername: 'ci-user@example-corp.com', allowedInstanceHosts: ['example-corp.my.salesforce.com'], denyOrgIds: [] };
    const evilPath = join(dir, 'policy.json'); writeFileSync(evilPath, JSON.stringify(evil));
    const args = ['--policy', evilPath, '--offline-fixtures', '--display-file', ex('display-production.json'), '--organization-file', ex('organization-production.json')];
    assert.equal(runCli(args).status, 0, 'without a pin, the tampered policy passes (this is the risk the pin addresses)');
    const pinned = runCli([...args, '--policy-sha256', pin]);
    assert.equal(pinned.status, 3);
    assert.match(pinned.stdout, /does not match the pinned SHA-256 digest/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('policy pin: a malformed digest is UNVERIFIABLE', () => {
  for (const bad of ['abc', 'g'.repeat(64), '', 'a'.repeat(63)]) {
    assert.equal(runCli(offlineArgs('display-qa.json', 'organization-qa.json', ['--policy-sha256', bad])).status, 3, bad);
  }
});

// --- Windows -----------------------------------------------------------------
test('windows: the SOQL text is quoted as a single argument', () => {
  const line = windowsCommandLine('sf', ['data', 'query', '--target-org', 'ci-user@example-corp.com.qa', '--query', 'SELECT Id, IsSandbox FROM Organization', '--json']);
  assert.equal(line, 'sf data query --target-org ci-user@example-corp.com.qa --query "SELECT Id, IsSandbox FROM Organization" --json');
});

test('windows: arguments with shell metacharacters are refused', () => {
  for (const bad of ['a"b', 'a%PATH%', 'a^b', 'a&b', 'a|b', 'a<b', 'a>b', 'a(b)', 'a!b', 'a\nb', '', 'a;b', 'a`b']) {
    assert.throws(() => windowsCommandLine('sf', [bad]), Unverifiable, JSON.stringify(bad));
  }
});

test('windows: spawn plan uses one command string with a shell; other platforms use an argument array without one', () => {
  const args = ['org', 'display', '--target-org', 'qa', '--json'];
  assert.deepEqual(spawnPlan(args, 'win32'), { command: 'sf org display --target-org qa --json', argv: undefined, shell: true });
  assert.deepEqual(spawnPlan(args, 'linux'), { command: 'sf', argv: args, shell: false });
  assert.deepEqual(spawnPlan(args, 'darwin'), { command: 'sf', argv: args, shell: false });
});

test('windows: a target alias that is valid for collect() also builds a valid command line', () => {
  const calls = [];
  collect({ runner: (a) => { calls.push(a); return { status: 0, stdout: '{}', stderr: '', timedOut: false }; }, targetOrg: 'ci-user@example-corp.com.qa' });
  for (const a of calls) assert.doesNotThrow(() => windowsCommandLine('sf', a));
});

test('paths: policy and fixture paths resolve through fileURLToPath on every platform', () => {
  assert.ok(!POLICY.startsWith('/C:') && !/^\/[A-Za-z]:/.test(POLICY));
  assert.doesNotThrow(() => readFileSync(POLICY));
});

// --- Timeout values ----------------------------------------------------------
test('timeout: invalid values are UNVERIFIABLE and the CLI is never started', () => {
  // A flag is used instead of assert.fail() inside the runner: main() converts every
  // exception into UNVERIFIABLE, so an assertion thrown there would be swallowed.
  let called = false;
  const runner = () => { called = true; return { status: 0, stdout: '{}', stderr: '', timedOut: false }; };
  for (const bad of ['abc', '0', '-5', '1.5', '', '600001', '99999999', 'NaN', '1e9']) {
    let code; capture((log) => { code = main(['--policy', POLICY, '--target-org', 'qa', '--timeout-ms', bad], { runner, log }); });
    assert.equal(code, EXIT.UNVERIFIABLE, bad);
    assert.equal(called, false, `the CLI must not be started for --timeout-ms ${JSON.stringify(bad)}`);
  }
});

test('timeout: a valid value is passed to the runner', () => {
  const seen = [];
  const runner = (args, t) => { seen.push(t); return { status: 0, stdout: JSON.stringify(args.includes('display') ? display() : organization()), stderr: '', timedOut: false }; };
  let code; capture((log) => { code = main(['--policy', POLICY, '--target-org', 'qa', '--timeout-ms', '2500'], { runner, log }); });
  assert.equal(code, EXIT.PASS);
  assert.deepEqual(seen, [2500, 2500]);
});
