// Turns raw Salesforce query records into the snapshot document the reconciliation
// reads. Pure: no CLI, file or network access.
//
// Correlation rule (deterministic, no inference):
//   userKey = the value of the single field named in the policy (EmployeeNumber or a
//   custom __c field), used exactly as stored.
// It is never derived from an e-mail address, a username, a name or a Salesforce Id.
//
// A user without a usable key cannot be reconciled. Active users like that are counted
// in `uncorrelatedUsers`, which prevents a PASS. Inactive users cannot sign in, so they
// are only counted in the diagnostics.

import { Unverifiable } from './errors.mjs';
import { DEFAULT_LIMITS } from './limits.mjs';
import { canonicalOrgId } from './policy.mjs';

const USER_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const malformed = () => new Unverifiable('E_CLI_OUTPUT', 'a Salesforce record has an unexpected shape');

/** Compare the org identity returned by the CLI with the policy. Fails closed. */
export function verifyOrganization(policy, organizationRecords) {
  if (!Array.isArray(organizationRecords) || organizationRecords.length !== 1) throw new Unverifiable('E_CLI_OUTPUT', 'the organization query must return exactly one record');
  const id = organizationRecords[0]?.Id;
  if (typeof id !== 'string' || !/^00D[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/.test(id)) throw new Unverifiable('E_CLI_OUTPUT', 'the organization record has a malformed Id');
  if (canonicalOrgId(id) !== canonicalOrgId(policy.expectedOrgId)) throw new Unverifiable('E_ORG_ID_MISMATCH', 'the target org is not the org named in the policy');
}

/**
 * Build the snapshot document and diagnostics.
 * Diagnostics are counts only; they never contain keys or Federation IDs.
 */
export function buildSnapshot(policy, userRecords, limits = DEFAULT_LIMITS) {
  if (!Array.isArray(userRecords)) throw malformed();
  if (userRecords.length > limits.maxUsers) throw new Unverifiable('E_LIMIT_RECORDS', 'the org has more users than the record limit');
  const included = new Set(policy.includedUserTypes);
  const users = [];
  const diagnostics = { totalRecords: userRecords.length, excludedByUserType: 0, uncorrelatedActive: 0, uncorrelatedInactive: 0, duplicateUserKeys: 0, duplicateFederationIds: 0 };

  for (const rec of userRecords) {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) throw malformed();
    const rawKey = rec[policy.correlationField];
    const fid = rec.FederationIdentifier ?? null;
    if (typeof rec.IsActive !== 'boolean' || typeof rec.UserType !== 'string') throw malformed();
    if (fid !== null && typeof fid !== 'string') throw malformed();
    if (rawKey !== null && rawKey !== undefined && typeof rawKey !== 'string') throw malformed();
    if (!included.has(rec.UserType)) { diagnostics.excludedByUserType += 1; continue; }
    if (typeof rawKey !== 'string' || !USER_KEY.test(rawKey)) {
      if (rec.IsActive) diagnostics.uncorrelatedActive += 1; else diagnostics.uncorrelatedInactive += 1;
      continue;
    }
    users.push({ userKey: rawKey, active: rec.IsActive, federationId: fid });
  }

  users.sort((a, b) => byCodeUnits(a.userKey, b.userKey) || (a.active === b.active ? 0 : a.active ? -1 : 1) || byCodeUnits(a.federationId ?? '', b.federationId ?? ''));

  const keyCounts = new Map();
  const fidCounts = new Map();
  for (const u of users) {
    keyCounts.set(u.userKey, (keyCounts.get(u.userKey) ?? 0) + 1);
    if (u.federationId !== null && u.federationId.trim() !== '') fidCounts.set(u.federationId, (fidCounts.get(u.federationId) ?? 0) + 1);
  }
  diagnostics.duplicateUserKeys = [...keyCounts.values()].filter((n) => n > 1).length;
  diagnostics.duplicateFederationIds = [...fidCounts.values()].filter((n) => n > 1).length;

  return {
    snapshot: {
      schemaVersion: 1,
      orgKey: policy.orgKey,
      users,
      totalSize: users.length,
      done: true,
      uncorrelatedUsers: diagnostics.uncorrelatedActive,
    },
    diagnostics,
  };
}
