import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, verifyOrganization } from '../src/snapshot.mjs';
import { validateSnapshot } from '../src/schema.mjs';
import { reconcile } from '../src/reconcile.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { Unverifiable } from '../src/errors.mjs';
import { DEFAULT_LIMITS } from '../src/limits.mjs';
import { fixtureJson } from '../testkit/fake-sf.mjs';
import { baseline, id } from '../testkit/builders.mjs';

const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof Unverifiable && e.code === code, `expected ${code}`);
const policy = () => validatePolicy(fixtureJson('policy.example.json'));
const rec = (key, fid, active = true, type = 'Standard') => ({ EmployeeNumber: key, IsActive: active, FederationIdentifier: fid, UserType: type });

test('organization identity: exact match on the 15-character form', () => {
  assert.doesNotThrow(() => verifyOrganization(policy(), [{ Id: '00DFICTIONAL000' }]));
  assert.doesNotThrow(() => verifyOrganization(policy(), [{ Id: '00DFICTIONAL000ABC' }])); // 18-character form of the same org
  rejects(() => verifyOrganization(policy(), [{ Id: '00DFICTIONAL001' }]), 'E_ORG_ID_MISMATCH');
  rejects(() => verifyOrganization(policy(), [{ Id: '00Dfictional000' }]), 'E_ORG_ID_MISMATCH'); // case matters
});

test('organization identity: malformed or ambiguous answers fail closed', () => {
  for (const records of [[], [{ Id: '00DFICTIONAL000' }, { Id: '00DFICTIONAL000' }], [{}], [{ Id: 5 }], [{ Id: 'x' }], [{ Id: '001FICTIONAL000' }], null, 'x']) {
    rejects(() => verifyOrganization(policy(), records), 'E_CLI_OUTPUT');
  }
});

test('the key comes only from the policy field, exactly as stored', () => {
  const { snapshot } = buildSnapshot(policy(), [rec('admin-001', 'f1')]);
  assert.deepEqual(snapshot.users, [{ userKey: 'admin-001', active: true, federationId: 'f1' }]);
});

test('e-mail, username and Id are never used to correlate (regression for the design rule)', () => {
  const records = [{ EmployeeNumber: null, Email: 'a@example.invalid', Username: 'a@example.invalid', Id: '005FICTIONAL001', IsActive: true, FederationIdentifier: 'a@example.invalid', UserType: 'Standard' }];
  const { snapshot, diagnostics } = buildSnapshot(policy(), records);
  assert.deepEqual(snapshot.users, []);
  assert.equal(snapshot.uncorrelatedUsers, 1);
  assert.equal(diagnostics.uncorrelatedActive, 1);
});

test('a custom correlation field is honored', () => {
  const p = validatePolicy({ ...fixtureJson('policy.example.json'), correlation: { field: 'Employee_Key__c' } });
  const { snapshot } = buildSnapshot(p, [{ Employee_Key__c: 'k-1', EmployeeNumber: 'ignored', IsActive: true, FederationIdentifier: 'f', UserType: 'Standard' }]);
  assert.equal(snapshot.users[0].userKey, 'k-1');
});

test('unusable keys count as uncorrelated; only ACTIVE ones block a pass', () => {
  const records = [rec(null, null), rec('', null), rec(' a', null), rec('a b', null), rec('x'.repeat(200), null), rec(null, null, false), rec('ok-1', 'f')];
  const { snapshot, diagnostics } = buildSnapshot(policy(), records);
  assert.equal(snapshot.users.length, 1);
  assert.equal(diagnostics.uncorrelatedActive, 5);
  assert.equal(diagnostics.uncorrelatedInactive, 1);
  assert.equal(snapshot.uncorrelatedUsers, 5);
});

test('user types outside the policy are excluded and counted', () => {
  const { snapshot, diagnostics } = buildSnapshot(policy(), [rec('a', 'f'), rec('b', 'g', true, 'AutomatedProcess'), rec(null, null, true, 'CloudIntegrationUser')]);
  assert.equal(snapshot.users.length, 1);
  assert.equal(diagnostics.excludedByUserType, 2);
  assert.equal(snapshot.uncorrelatedUsers, 0); // excluded types are not "uncorrelated"
});

test('duplicate keys and duplicate Federation IDs are kept for the reconciliation and counted', () => {
  const { snapshot, diagnostics } = buildSnapshot(policy(), [rec('a', 'f1'), rec('a', 'f2'), rec('b', 'same'), rec('c', 'same')]);
  assert.equal(snapshot.users.length, 4);
  assert.equal(diagnostics.duplicateUserKeys, 1);
  assert.equal(diagnostics.duplicateFederationIds, 1);
  const result = reconcile(baseline([id('a', 'f1'), id('b', 'same'), id('c', 'other')]), snapshot);
  assert.equal(result.findings.find((f) => f.userKey === 'a').status, 'AMBIGUOUS');
  assert.equal(result.findings.find((f) => f.userKey === 'b').status, 'DUPLICATE_ACTUAL');
});

test('output is deterministic whatever the order of the records', () => {
  const records = [rec('b', 'f2'), rec('B', 'f1'), rec('a', null), rec('a', 'x', false), rec('z', 'f3')];
  const forward = JSON.stringify(buildSnapshot(policy(), records));
  const reversed = JSON.stringify(buildSnapshot(policy(), [...records].reverse()));
  assert.equal(forward, reversed);
  assert.deepEqual(JSON.parse(forward).snapshot.users.map((u) => u.userKey), ['B', 'a', 'a', 'b', 'z']);
});

test('the built snapshot satisfies the snapshot schema and declares itself complete', () => {
  const { snapshot } = buildSnapshot(policy(), [rec('a', 'f'), rec('b', null)]);
  const checked = validateSnapshot(snapshot);
  assert.equal(checked.declaredSize, 2);
  assert.equal(checked.done, true);
});

test('an active user without a key prevents PASS even when every approved identity matches', () => {
  const b = baseline([id('a', 'f')]);
  assert.equal(reconcile(b, buildSnapshot(policy(), [rec('a', 'f')]).snapshot).verdict, 'PASS');
  const r = reconcile(b, buildSnapshot(policy(), [rec('a', 'f'), rec(null, null)]).snapshot);
  assert.equal(r.verdict, 'REVIEW_REQUIRED');
  assert.equal(r.uncorrelatedUsers, 1);
});

test('unexpected record shapes fail closed', () => {
  const bad = [
    { ...rec('a', 'f'), IsActive: 'true' }, { ...rec('a', 'f'), IsActive: undefined }, { ...rec('a', 'f'), UserType: 5 },
    { ...rec('a', 'f'), FederationIdentifier: 5 }, { ...rec('a', 'f'), EmployeeNumber: 5 }, { ...rec('a', 'f'), EmployeeNumber: {} },
  ];
  for (const r of bad) rejects(() => buildSnapshot(policy(), [r]), 'E_CLI_OUTPUT');
  rejects(() => buildSnapshot(policy(), 'x'), 'E_CLI_OUTPUT');
  for (const r of [null, 5, 'x', []]) rejects(() => buildSnapshot(policy(), [r]), 'E_CLI_OUTPUT'); // regression: null used to raise a TypeError
});

test('a Federation ID with forbidden characters is rejected when the snapshot is validated', () => {
  const { snapshot } = buildSnapshot(policy(), [rec('a', `f${String.fromCodePoint(0x202e)}x`)]);
  rejects(() => validateSnapshot(snapshot), 'E_SCHEMA');
});

test('the user record limit is enforced', () => {
  const tight = { ...DEFAULT_LIMITS, maxUsers: 2 };
  rejects(() => buildSnapshot(policy(), [rec('a', 'f'), rec('b', 'f'), rec('c', 'f')], tight), 'E_LIMIT_RECORDS');
});

test('the shipped fixtures give one active uncorrelated user and one excluded type', () => {
  const { snapshot, diagnostics } = buildSnapshot(policy(), fixtureJson('sf/users.json').result.records);
  assert.equal(snapshot.users.length, 4);
  assert.deepEqual(diagnostics, { totalRecords: 6, excludedByUserType: 1, uncorrelatedActive: 1, uncorrelatedInactive: 0, duplicateUserKeys: 0, duplicateFederationIds: 0 });
});

test('diagnostics contain counts only', () => {
  const { diagnostics } = buildSnapshot(policy(), [rec('SECRET-KEY-1', 'SECRET-FID-1'), rec('SECRET-KEY-1', 'SECRET-FID-1')]);
  assert.ok(!JSON.stringify(diagnostics).includes('SECRET'));
  assert.ok(Object.values(diagnostics).every((n) => Number.isInteger(n)));
});
