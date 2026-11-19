// Read-only inventory of the SSO mechanisms configured in an org. Pure.
//
// It reports what is configured. It does not show that any of it works.
//
// Values that identify the identity provider (issuer, login URL) are reduced to a short
// SHA-256 fingerprint. Fingerprints let two inventories be compared for drift without
// printing the URLs. Secrets are never queried (see queries.mjs).

import { createHash } from 'node:crypto';
import { Unverifiable } from './errors.mjs';
import { hasForbiddenChar } from './schema.mjs';

const MAX_TEXT = 200;
const MAX_ITEMS = 1000;
const malformed = () => new Unverifiable('E_CLI_OUTPUT', 'an SSO configuration record has an unexpected shape');
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function text(value, { optional = false } = {}) {
  if ((value === null || value === undefined) && optional) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT || hasForbiddenChar(value)) throw malformed();
  return value;
}

/** First 12 hex characters of the SHA-256 of a value, or null when the value is empty. */
export function fingerprint(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw malformed();
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

const isRecord = (r) => r !== null && typeof r === 'object' && !Array.isArray(r);

export function buildInventory(orgKey, samlRecords, authProviderRecords) {
  if (!Array.isArray(samlRecords) || !Array.isArray(authProviderRecords)) throw malformed();
  if (!samlRecords.every(isRecord) || !authProviderRecords.every(isRecord)) throw malformed();
  if (samlRecords.length > MAX_ITEMS || authProviderRecords.length > MAX_ITEMS) throw new Unverifiable('E_LIMIT_RECORDS', 'the SSO inventory exceeds the record limit');

  const samlConfigs = samlRecords.map((r) => {
    if (typeof r.OptionsUserProvisioning !== 'boolean') throw malformed();
    return {
      developerName: text(r.DeveloperName),
      label: text(r.MasterLabel),
      identityMapping: text(r.IdentityMapping, { optional: true }),
      identityLocation: text(r.IdentityLocation, { optional: true }),
      userProvisioning: r.OptionsUserProvisioning,
      issuerFingerprint: fingerprint(r.Issuer),
      loginUrlFingerprint: fingerprint(r.LoginUrl),
    };
  }).sort((a, b) => byCodeUnits(a.developerName, b.developerName));

  const authProviders = authProviderRecords.map((r) => ({
    developerName: text(r.DeveloperName),
    friendlyName: text(r.FriendlyName),
    providerType: text(r.ProviderType),
  })).sort((a, b) => byCodeUnits(a.developerName, b.developerName));

  for (const list of [samlConfigs, authProviders]) {
    for (let i = 1; i < list.length; i++) {
      if (list[i].developerName === list[i - 1].developerName) throw new Unverifiable('E_CLI_OUTPUT', 'the SSO inventory contains a duplicate developer name');
    }
  }

  return {
    schemaVersion: 1,
    orgKey,
    mode: 'READ_ONLY',
    summary: {
      samlConfigCount: samlConfigs.length,
      authProviderCount: authProviders.length,
      federationIdMappedSamlConfigs: samlConfigs.filter((c) => c.identityMapping === 'FederationId').length,
      usernameMappedSamlConfigs: samlConfigs.filter((c) => c.identityMapping === 'Username').length,
      userProvisioningSamlConfigs: samlConfigs.filter((c) => c.userProvisioning).length,
    },
    samlConfigs,
    authProviders,
  };
}
