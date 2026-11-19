import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePolicy, loadPolicy, validateTargetOrg, canonicalOrgId } from '../src/policy.mjs';
import { Unverifiable } from '../src/errors.mjs';
import { fixtureJson, fixturePath } from '../testkit/fake-sf.mjs';

const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof Unverifiable && e.code === code, `expected ${code}`);
const good = () => fixtureJson('policy.example.json');

test('the shipped example policy is valid', () => {
  assert.deepEqual(validatePolicy(good()), { orgKey: 'fictional-qa', expectedOrgId: '00DFICTIONAL000', correlationField: 'EmployeeNumber', includedUserTypes: ['Standard'] });
});

test('unsupported schema versions, unknown fields and wrong types are rejected', () => {
  for (const doc of [null, [], 'x', 5]) rejects(() => validatePolicy(doc), 'E_POLICY');
  for (const v of [0, 2, '1', undefined]) rejects(() => validatePolicy({ ...good(), schemaVersion: v }), 'E_POLICY');
  rejects(() => validatePolicy({ ...good(), extra: 1 }), 'E_POLICY');
  rejects(() => validatePolicy({ ...good(), correlation: { field: 'EmployeeNumber', extra: 1 } }), 'E_POLICY');
  rejects(() => validatePolicy({ ...good(), correlation: null }), 'E_POLICY');
});

test('org identifiers: 15 or 18 characters starting with 00D', () => {
  for (const id of ['', 'abc', '001FICTIONAL000', '00DFICTIONAL00', '00DFICTIONAL000AAAA', 5, null, '00DFICTIONAL000 ']) {
    rejects(() => validatePolicy({ ...good(), expectedOrgId: id }), 'E_POLICY');
  }
  assert.equal(validatePolicy({ ...good(), expectedOrgId: '00DFICTIONAL000AAA' }).expectedOrgId, '00DFICTIONAL000AAA');
});

test('the correlation field can never be an e-mail, username, name or Federation ID field', () => {
  for (const field of ['Email', 'Username', 'FederationIdentifier', 'Id', 'Name', 'Alias', 'CommunityNickname', 'employeenumber', 'Employee__c ', '__c', 'a__c;DROP', 'x.y__c', 5, null]) {
    rejects(() => validatePolicy({ ...good(), correlation: { field } }), 'E_POLICY');
  }
  for (const field of ['EmployeeNumber', 'Employee_Key__c', 'A__c']) {
    assert.equal(validatePolicy({ ...good(), correlation: { field } }).correlationField, field);
  }
});

test('included user types are validated', () => {
  for (const types of [[], 'Standard', ['Standard', 'Standard'], ['bad type'], [5], Array.from({ length: 11 }, (_, i) => `T${i}`), ['1Standard']]) {
    rejects(() => validatePolicy({ ...good(), includedUserTypes: types }), 'E_POLICY');
  }
});

test('policy pin: exact digest passes, any other digest or malformed pin fails', () => {
  const bytes = JSON.stringify(good());
  const dir = mkdtempSync(join(tmpdir(), 'sso-policy-'));
  try {
    const path = join(dir, 'policy.json');
    writeFileSync(path, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(loadPolicy(path, digest).sha256, digest);
    assert.ok(loadPolicy(path).policy);
    rejects(() => loadPolicy(path, '0'.repeat(64)), 'E_POLICY_PIN');
    for (const pin of ['', 'abc', digest.toUpperCase(), `${digest} `, 5]) rejects(() => loadPolicy(path, pin), 'E_POLICY_PIN');
    writeFileSync(path, `${bytes} `); // one extra byte changes the digest
    rejects(() => loadPolicy(path, digest), 'E_POLICY_PIN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('policy files with duplicate keys or invalid JSON are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sso-policy-'));
  try {
    const path = join(dir, 'p.json');
    writeFileSync(path, '{"schemaVersion":1,"schemaVersion":1}');
    rejects(() => loadPolicy(path), 'E_INPUT_DUPLICATE_KEY');
    writeFileSync(path, '{ nope');
    rejects(() => loadPolicy(path), 'E_INPUT_INVALID_JSON');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(fixturePath('policy.example.json').endsWith('policy.example.json'));
});

test('target org values: safe aliases only, never anything that looks like an option', () => {
  for (const ok of ['qa', 'fictional-qa', 'ci.user@example.invalid', 'A_b-1']) assert.equal(validateTargetOrg(ok), ok);
  for (const bad of ['', '-qa', '--json', 'a b', 'a;b', 'a&b', 'a|b', '$(x)', '`x`', 'a"b', "a'b", 'a\nb', 'x'.repeat(101), 5, null, undefined]) {
    rejects(() => validateTargetOrg(bad), 'E_TARGET_ORG');
  }
});

test('org identifiers compare on the 15-character, case-sensitive form', () => {
  assert.equal(canonicalOrgId('00DFICTIONAL000AAA'), '00DFICTIONAL000');
  assert.notEqual(canonicalOrgId('00DFICTIONAL000'), canonicalOrgId('00Dfictional000'));
});
