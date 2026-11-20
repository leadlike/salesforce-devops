// Read-only reconciliation of an approved Federation ID baseline against a snapshot
// of Salesforce users. Pure function: no file, network or process access.
//
// Correlation uses the approved `userKey` only. Identity is never inferred from an
// e-mail address or a username, and a Federation ID is never assumed to equal an
// e-mail address. Federation ID values are compared exactly (case-sensitive) and are
// never written to the result.

import { Unverifiable } from './errors.mjs';
import { DEFAULT_LIMITS } from './limits.mjs';
import { validateBaseline, validateSnapshot } from './schema.mjs';

export const STATUS = Object.freeze({
  MATCH: 'MATCH',
  MISSING: 'MISSING',
  MISMATCH: 'MISMATCH',
  INACTIVE: 'INACTIVE',
  DUPLICATE_ACTUAL: 'DUPLICATE_ACTUAL',
  AMBIGUOUS: 'AMBIGUOUS',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  UNMANAGED: 'UNMANAGED',
});

const hasValue = (federationId) => typeof federationId === 'string' && federationId.trim().length > 0;

// UTF-16 code unit order. Unlike localeCompare, it does not depend on the machine's locale.
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function count(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Reconcile a baseline and a snapshot.
 * Throws Unverifiable when the inputs cannot support a trustworthy result.
 */
export function reconcile(baselineDoc, snapshotDoc, limits = DEFAULT_LIMITS) {
  const baseline = validateBaseline(baselineDoc, limits);
  const snapshot = validateSnapshot(snapshotDoc, limits);

  if (baseline.orgKey !== snapshot.orgKey) throw new Unverifiable('E_ORG_MISMATCH', 'baseline and snapshot describe different organizations');
  // A snapshot that declares itself incomplete cannot prove that a Federation ID is unique.
  if (snapshot.done === false) throw new Unverifiable('E_SNAPSHOT_INCOMPLETE', 'snapshot is marked incomplete');
  if (snapshot.declaredSize !== null && snapshot.declaredSize !== snapshot.users.length) {
    throw new Unverifiable('E_SNAPSHOT_INCOMPLETE', 'snapshot size does not match its declared total');
  }

  // Index the baseline. Maps (not plain objects) are used so that keys such as
  // "__proto__" are ordinary data.
  const expectedByKey = new Map();
  const duplicateBaselineKeys = new Set();
  const expectedIdCounts = new Map();
  for (const entry of baseline.identities) {
    if (expectedByKey.has(entry.userKey)) duplicateBaselineKeys.add(entry.userKey);
    expectedByKey.set(entry.userKey, entry);
    count(expectedIdCounts, entry.federationId);
  }

  // Index the snapshot.
  const usersByKey = new Map();
  const duplicateSnapshotKeys = new Set();
  const actualIdCounts = new Map();
  for (const user of snapshot.users) {
    if (usersByKey.has(user.userKey)) duplicateSnapshotKeys.add(user.userKey);
    usersByKey.set(user.userKey, user);
    if (hasValue(user.federationId)) count(actualIdCounts, user.federationId);
  }

  const findings = [];
  for (const [userKey, entry] of expectedByKey) {
    const user = usersByKey.get(userKey);
    let status;
    if (duplicateBaselineKeys.has(userKey) || duplicateSnapshotKeys.has(userKey) || expectedIdCounts.get(entry.federationId) > 1) status = STATUS.AMBIGUOUS;
    else if (!user) status = STATUS.USER_NOT_FOUND;
    else if (!user.active) status = STATUS.INACTIVE;
    else if (hasValue(user.federationId) && actualIdCounts.get(user.federationId) > 1) status = STATUS.DUPLICATE_ACTUAL;
    else if (!hasValue(user.federationId)) status = STATUS.MISSING;
    else if (user.federationId !== entry.federationId) status = STATUS.MISMATCH;
    else status = STATUS.MATCH;
    findings.push({ userKey, status });
  }
  for (const userKey of usersByKey.keys()) {
    if (!expectedByKey.has(userKey)) findings.push({ userKey, status: duplicateSnapshotKeys.has(userKey) ? STATUS.AMBIGUOUS : STATUS.UNMANAGED });
  }

  findings.sort((a, b) => byCodeUnits(a.userKey, b.userKey));
  const tally = new Map();
  for (const finding of findings) count(tally, finding.status);
  const counts = {};
  for (const status of [...tally.keys()].sort(byCodeUnits)) counts[status] = tally.get(status);

  // The baseline is guaranteed to be non-empty, so `findings` is never empty and PASS
  // cannot be reached without at least one identity having been verified.
  const allMatch = findings.length > 0 && snapshot.uncorrelatedUsers === 0 && findings.every((f) => f.status === STATUS.MATCH);
  return {
    schemaVersion: 1,
    orgKey: baseline.orgKey,
    mode: 'READ_ONLY',
    verdict: allMatch ? 'PASS' : 'REVIEW_REQUIRED',
    counts,
    uncorrelatedUsers: snapshot.uncorrelatedUsers,
    findings,
  };
}
