import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate, collect, main, validatePolicy, EXIT, Unverifiable } from '../org-guard.mjs';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policy = () => load('../policy.example.json');
const display = () => load('../examples/display-qa.json');
const organization = () => load('../examples/organization-qa.json');
const run = (over = {}) => evaluate({ policy: policy(), display: display(), organization: organization(), ...over });
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

// --- Positive case -------------------------------------------------------
test('PASS when every check matches', () => {
  const r = run();
  assert.equal(r.code, EXIT.PASS);
  assert.equal(r.verdict, 'PASS');
  assert.deepEqual(failed(r), []);
});

// --- Policy violations (BLOCKED) ------------------------------------------
test('BLOCKED: wrong org ID', () => {
  const d = display(); d.result.id = '00D000000000XXXAAA';
  const o = organization(); o.result.records[0].Id = '00D000000000XXXAAA';
  const r = run({ display: d, organization: o });
  assert.equal(r.code, EXIT.BLOCKED);
  assert.deepEqual(failed(r), ['org-id']);
});

test('BLOCKED: org is on the deny list (and org-id mismatch also reported)', () => {
  const d = display(); d.result.id = '00D000000000PRDAAA';
  const o = organization(); o.result.records[0].Id = '00D000000000PRDAAA';
  const r = run({ display: d, organization: o });
  assert.equal(r.code, EXIT.BLOCKED);
  assert.ok(failed(r).includes('deny-list'));
});

test('BLOCKED: production target when policy expects a sandbox', () => {
  const o = organization(); o.result.records[0].IsSandbox = false;
  const r = run({ organization: o });
  assert.equal(r.code, EXIT.BLOCKED);
  assert.deepEqual(failed(r), ['environment-type']);
});

test('BLOCKED: instance host not on the allow list', () => {
  const d = display(); d.result.instanceUrl = 'https://other-corp--qa.sandbox.my.salesforce.com';
  const r = run({ display: d });
  assert.equal(r.code, EXIT.BLOCKED);
  assert.deepEqual(failed(r), ['instance-host']);
});

test('BLOCKED: look-alike host is not a suffix match', () => {
  const d = display(); d.result.instanceUrl = 'https://example-corp--qa.sandbox.my.salesforce.com.attacker.test';
  assert.deepEqual(failed(run({ display: d })), ['instance-host']);
});

test('BLOCKED: unexpected authenticated username', () => {
  const d = display(); d.result.username = 'someone-else@example-corp.com.qa';
  const r = run({ display: d });
  assert.equal(r.code, EXIT.BLOCKED);
  assert.deepEqual(failed(r), ['username']);
});

test('15 and 18 character org IDs are treated as the same org', () => {
  const d = display(); d.result.id = d.result.id.slice(0, 15);
  const o = organization(); o.result.records[0].Id = o.result.records[0].Id.slice(0, 15);
  assert.equal(run({ display: d, organization: o }).code, EXIT.PASS);
});

test('org ID comparison is case-sensitive on the 15 character form', () => {
  const d = display(); d.result.id = '00D000000000qa1AAA';
  const o = organization(); o.result.records[0].Id = '00D000000000qa1AAA';
  assert.deepEqual(failed(run({ display: d, organization: o })), ['org-id']);
});

// --- Fail closed (UNVERIFIABLE) -------------------------------------------
test('UNVERIFIABLE: org display reports failure', () => {
  assert.equal(run({ display: { status: 1, message: 'No authorization found' } }).code, EXIT.UNVERIFIABLE);
});

test('UNVERIFIABLE: display result missing a required field', () => {
  const d = display(); delete d.result.username;
  assert.equal(run({ display: d }).code, EXIT.UNVERIFIABLE);
});

test('UNVERIFIABLE: malformed org ID', () => {
  const d = display(); d.result.id = 'not-an-org-id';
  assert.equal(run({ display: d }).code, EXIT.UNVERIFIABLE);
});

test('UNVERIFIABLE: malformed instanceUrl', () => {
  const d = display(); d.result.instanceUrl = '::::';
  assert.equal(run({ display: d }).code, EXIT.UNVERIFIABLE);
});

test('UNVERIFIABLE: organization query returns zero or several records', () => {
  const none = organization(); none.result.records = [];
  const many = organization(); many.result.records.push({ ...many.result.records[0] });
  assert.equal(run({ organization: none }).code, EXIT.UNVERIFIABLE);
  assert.equal(run({ organization: many }).code, EXIT.UNVERIFIABLE);
});

test('UNVERIFIABLE: IsSandbox missing or not a boolean', () => {
  const o = organization(); o.result.records[0].IsSandbox = 'true';
  assert.equal(run({ organization: o }).code, EXIT.UNVERIFIABLE);
});

test('UNVERIFIABLE: the two sources describe different orgs', () => {
  const o = organization(); o.result.records[0].Id = '00D000000000OTHAAA';
  assert.equal(run({ organization: o }).code, EXIT.UNVERIFIABLE);
});

test('UNVERIFIABLE: invalid policy (each rule)', () => {
  const cases = [
    { ...policy(), expectedOrgId: 'bad' },
    { ...policy(), environmentType: 'staging' },
    { ...policy(), expectedUsername: 'no-at-sign' },
    { ...policy(), allowedInstanceHosts: [] },
    { ...policy(), allowedInstanceHosts: ['https://not-a-host/'] },
    { ...policy(), denyOrgIds: ['bad'] },
    { ...policy(), denyOrgIds: ['00D000000000QA1AAA'] }, // expected org also denied
    null,
  ];
  for (const p of cases) assert.equal(run({ policy: p }).code, EXIT.UNVERIFIABLE, JSON.stringify(p));
});

test('validatePolicy throws Unverifiable', () => {
  assert.throws(() => validatePolicy({}), Unverifiable);
});

// --- collect(): CLI interaction with an injected runner -------------------
const okRunner = (args) => ({ status: 0, stdout: JSON.stringify(args.includes('display') ? display() : organization()), stderr: '', timedOut: false });

test('collect: happy path uses the expected CLI arguments', () => {
  const calls = [];
  const runner = (args, t) => { calls.push({ args, t }); return okRunner(args); };
  const data = collect({ runner, targetOrg: 'qa-sandbox', timeoutMs: 1234 });
  assert.equal(evaluate({ policy: policy(), ...data }).code, EXIT.PASS);
  assert.deepEqual(calls[0].args, ['org', 'display', '--target-org', 'qa-sandbox', '--json']);
  assert.equal(calls[0].t, 1234);
  assert.ok(calls[1].args.includes('SELECT Id, IsSandbox FROM Organization'));
});

test('collect: timeout is UNVERIFIABLE', () => {
  const runner = () => ({ status: null, stdout: '', stderr: '', timedOut: true });
  assert.throws(() => collect({ runner, targetOrg: 'qa' }), /timed out/);
});

test('collect: malformed (non-JSON) CLI output is UNVERIFIABLE', () => {
  const runner = () => ({ status: 0, stdout: 'Warning: update available\n{broken', stderr: '', timedOut: false });
  assert.throws(() => collect({ runner, targetOrg: 'qa' }), /not valid JSON/);
});

test('collect: CLI not installed is UNVERIFIABLE with a clear reason', () => {
  const runner = () => ({ status: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' });
  assert.throws(() => collect({ runner, targetOrg: 'qa' }), /could not run the Salesforce CLI \(ENOENT\)/);
});

test('collect: CLI crash with no output is UNVERIFIABLE', () => {
  const runner = () => ({ status: 1, stdout: '', stderr: 'boom', timedOut: false });
  assert.throws(() => collect({ runner, targetOrg: 'qa' }), /exited with status 1/);
});

test('collect: rejects target aliases that could inject shell syntax', () => {
  const runner = () => assert.fail('the CLI must not be called');
  for (const bad of ['qa; rm -rf /', 'qa && calc', '$(whoami)', 'a b', '', undefined]) {
    assert.throws(() => collect({ runner, targetOrg: bad }), Unverifiable);
  }
});

// --- main(): exit codes and output ----------------------------------------
// fileURLToPath (not URL.pathname) so that paths are valid on Windows as well.
const policyPath = fileURLToPath(new URL('../policy.example.json', import.meta.url));
const ex = (f) => fileURLToPath(new URL(`../examples/${f}`, import.meta.url));

test('main: live mode PASS with an injected runner', () => {
  const out = []; const code = main(['--policy', policyPath, '--target-org', 'qa'], { runner: okRunner, log: (s) => out.push(s) });
  assert.equal(code, EXIT.PASS);
  assert.match(out[0], /MODE: live/);
  assert.match(out[0], /RESULT: PASS/);
});

test('main: offline fixtures are clearly labeled', () => {
  const out = []; const code = main(['--policy', policyPath, '--offline-fixtures', '--display-file', ex('display-qa.json'), '--organization-file', ex('organization-qa.json')], { log: (s) => out.push(s) });
  assert.equal(code, EXIT.PASS);
  assert.match(out[0], /NOT a live verification/);
});

test('main: production fixtures are BLOCKED against the QA policy', () => {
  const out = []; const code = main(['--policy', policyPath, '--offline-fixtures', '--display-file', ex('display-production.json'), '--organization-file', ex('organization-production.json')], { log: (s) => out.push(s) });
  assert.equal(code, EXIT.BLOCKED);
  assert.match(out[0], /FAIL {2}deny-list/);
  assert.match(out[0], /RESULT: BLOCKED/);
});

test('main: missing policy, unknown argument and unreadable policy are UNVERIFIABLE', () => {
  const log = () => {};
  assert.equal(main([], { log }), EXIT.UNVERIFIABLE);
  assert.equal(main(['--bogus'], { log }), EXIT.UNVERIFIABLE);
  assert.equal(main(['--policy', '/nonexistent/policy.json', '--target-org', 'qa'], { log }), EXIT.UNVERIFIABLE);
});

test('output never contains the access token (log callback and raw stdout)', () => {
  const out = [];
  const realLog = console.log; const realWrite = process.stdout.write;
  console.log = (...a) => out.push(a.join(' '));
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  try {
    main(['--policy', policyPath, '--offline-fixtures', '--display-file', ex('display-qa.json'), '--organization-file', ex('organization-qa.json')], { log: (s) => out.push(s) });
    main(['--policy', policyPath, '--target-org', 'qa'], { runner: okRunner, log: (s) => out.push(s) });
    evaluate({ policy: policy(), display: display(), organization: organization() });
  } finally { console.log = realLog; process.stdout.write = realWrite; }
  assert.ok(!out.join('\n').includes('FAKE-TOKEN'));
});
