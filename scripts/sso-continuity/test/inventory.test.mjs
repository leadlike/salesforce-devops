import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInventory, fingerprint } from '../src/inventory.mjs';
import { Unverifiable } from '../src/errors.mjs';
import { fixtureJson } from '../testkit/fake-sf.mjs';

const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof Unverifiable && e.code === code, `expected ${code}`);
const saml = (over = {}) => ({ DeveloperName: 'A_IdP', MasterLabel: 'A IdP', IdentityMapping: 'FederationId', IdentityLocation: 'SubjectNameId', OptionsUserProvisioning: false, Issuer: 'https://idp.example.invalid/i', LoginUrl: 'https://idp.example.invalid/l', ...over });
const provider = (over = {}) => ({ DeveloperName: 'P_One', FriendlyName: 'P One', ProviderType: 'OpenIdConnect', ...over });

test('inventory of the fictional fixtures', () => {
  const inv = buildInventory('fictional-qa', fixtureJson('sf/saml.json').result.records, fixtureJson('sf/authproviders.json').result.records);
  assert.equal(inv.mode, 'READ_ONLY');
  assert.deepEqual(inv.summary, { samlConfigCount: 1, authProviderCount: 1, federationIdMappedSamlConfigs: 1, usernameMappedSamlConfigs: 0, userProvisioningSamlConfigs: 0 });
  assert.equal(inv.samlConfigs[0].developerName, 'Fictional_IdP');
});

test('issuer and login URL are reduced to fingerprints and never printed', () => {
  const inv = buildInventory('o', [saml()], []);
  const text = JSON.stringify(inv);
  assert.ok(!text.includes('example.invalid'));
  assert.match(inv.samlConfigs[0].issuerFingerprint, /^[0-9a-f]{12}$/);
  assert.notEqual(inv.samlConfigs[0].issuerFingerprint, inv.samlConfigs[0].loginUrlFingerprint);
});

test('fingerprints are stable, sensitive to change, and null when empty', () => {
  assert.equal(fingerprint('a'), fingerprint('a'));
  assert.notEqual(fingerprint('a'), fingerprint('A'));
  assert.equal(fingerprint(null), null);
  assert.equal(fingerprint(''), null);
  assert.equal(fingerprint(undefined), null);
  rejects(() => fingerprint(5), 'E_CLI_OUTPUT');
});

test('drift is visible: a changed issuer changes the fingerprint only', () => {
  const a = buildInventory('o', [saml()], []).samlConfigs[0];
  const b = buildInventory('o', [saml({ Issuer: 'https://idp.example.invalid/other' })], []).samlConfigs[0];
  assert.notEqual(a.issuerFingerprint, b.issuerFingerprint);
  assert.equal(a.loginUrlFingerprint, b.loginUrlFingerprint);
});

test('summary counts by identity mapping and provisioning', () => {
  const inv = buildInventory('o', [saml(), saml({ DeveloperName: 'B', MasterLabel: 'B', IdentityMapping: 'Username', OptionsUserProvisioning: true }), saml({ DeveloperName: 'C', MasterLabel: 'C', IdentityMapping: null })], []);
  assert.deepEqual(inv.summary, { samlConfigCount: 3, authProviderCount: 0, federationIdMappedSamlConfigs: 1, usernameMappedSamlConfigs: 1, userProvisioningSamlConfigs: 1 });
});

test('an org with no SSO is a valid, empty inventory', () => {
  const inv = buildInventory('o', [], []);
  assert.equal(inv.summary.samlConfigCount, 0);
  assert.deepEqual(inv.samlConfigs, []);
});

test('output is sorted deterministically', () => {
  const a = buildInventory('o', [saml({ DeveloperName: 'b', MasterLabel: 'b' }), saml({ DeveloperName: 'B', MasterLabel: 'B' }), saml({ DeveloperName: 'a', MasterLabel: 'a' })], [provider({ DeveloperName: 'z' }), provider({ DeveloperName: 'y' })]);
  assert.deepEqual(a.samlConfigs.map((c) => c.developerName), ['B', 'a', 'b']);
  assert.deepEqual(a.authProviders.map((p) => p.developerName), ['y', 'z']);
  assert.equal(JSON.stringify(a), JSON.stringify(buildInventory('o', [saml({ DeveloperName: 'a', MasterLabel: 'a' }), saml({ DeveloperName: 'B', MasterLabel: 'B' }), saml({ DeveloperName: 'b', MasterLabel: 'b' })], [provider({ DeveloperName: 'y' }), provider({ DeveloperName: 'z' })])));
});

test('duplicates, malformed shapes and unsafe text fail closed', () => {
  rejects(() => buildInventory('o', [saml(), saml()], []), 'E_CLI_OUTPUT');
  rejects(() => buildInventory('o', [], [provider(), provider()]), 'E_CLI_OUTPUT');
  rejects(() => buildInventory('o', 'x', []), 'E_CLI_OUTPUT');
  rejects(() => buildInventory('o', [], null), 'E_CLI_OUTPUT');
  for (const over of [{ DeveloperName: '' }, { DeveloperName: 5 }, { MasterLabel: null }, { DeveloperName: 'x'.repeat(201) }, { MasterLabel: `a${String.fromCodePoint(0x202e)}b` }, { MasterLabel: 'a\nb' }, { OptionsUserProvisioning: 'false' }, { OptionsUserProvisioning: undefined }, { Issuer: 5 }, { IdentityMapping: 5 }]) {
    rejects(() => buildInventory('o', [saml(over)], []), 'E_CLI_OUTPUT');
  }
  rejects(() => buildInventory('o', [], [provider({ ProviderType: null })]), 'E_CLI_OUTPUT');
});

test('record limits are enforced', () => {
  const many = Array.from({ length: 1001 }, (_, i) => saml({ DeveloperName: `D${i}`, MasterLabel: `L${i}` }));
  rejects(() => buildInventory('o', many, []), 'E_LIMIT_RECORDS');
});

test('unknown extra fields in CLI records are ignored and never copied to the output', () => {
  const inv = buildInventory('o', [saml({ ValidationCert: 'SECRET-CERT-DATA', Audience: 'SECRET-AUDIENCE' })], [provider({ ConsumerSecret: 'SECRET-OAUTH' })]);
  assert.ok(!JSON.stringify(inv).includes('SECRET'));
});

test('non-object records fail closed instead of raising a TypeError (regression)', () => {
  for (const r of [null, 5, 'x', []]) {
    rejects(() => buildInventory('o', [r], []), 'E_CLI_OUTPUT');
    rejects(() => buildInventory('o', [], [r]), 'E_CLI_OUTPUT');
  }
});
