'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}
function nonempty(v) { return typeof v === 'string' && v.trim().length > 0; }
function reconcile(baseline, snapshot) {
  assertObject(baseline, 'baseline'); assertObject(snapshot, 'snapshot');
  if (!nonempty(baseline.orgKey) || !nonempty(snapshot.orgKey) || baseline.orgKey !== snapshot.orgKey) throw new Error('Organization mismatch');
  if (!Array.isArray(baseline.identities) || !Array.isArray(snapshot.users)) throw new Error('Invalid input arrays');
  if (baseline.schemaVersion !== 1 || snapshot.schemaVersion !== 1) throw new Error('Unsupported schema version');
  const byId = new Map(), expectedIds = new Map(), actualIds = new Map(), duplicateBaselineIds = new Set();
  for (const entry of baseline.identities) {
    assertObject(entry, 'baseline identity');
    if (!nonempty(entry.userKey) || !nonempty(entry.federationId)) throw new Error('Invalid baseline identity');
    if (byId.has(entry.userKey)) duplicateBaselineIds.add(entry.userKey);
    byId.set(entry.userKey, entry);
    const f = entry.federationId;
    expectedIds.set(f, (expectedIds.get(f) || 0) + 1);
  }
  const users = new Map(), duplicateSnapshotIds = new Set();
  for (const user of snapshot.users) {
    assertObject(user, 'snapshot user');
    if (!nonempty(user.userKey) || typeof user.active !== 'boolean' || (user.federationId != null && typeof user.federationId !== 'string')) throw new Error('Invalid snapshot user');
    if (users.has(user.userKey)) duplicateSnapshotIds.add(user.userKey);
    users.set(user.userKey, user);
    if (nonempty(user.federationId)) actualIds.set(user.federationId, (actualIds.get(user.federationId) || 0) + 1);
  }
  const findings = [];
  for (const [key, entry] of byId) {
    const user = users.get(key);
    let status;
    if (duplicateBaselineIds.has(key) || duplicateSnapshotIds.has(key) || expectedIds.get(entry.federationId) > 1) status = 'AMBIGUOUS';
    else if (!user) status = 'USER_NOT_FOUND';
    else if (!user.active) status = 'INACTIVE';
    else if (nonempty(user.federationId) && actualIds.get(user.federationId) > 1) status = 'DUPLICATE_ACTUAL';
    else if (!nonempty(user.federationId)) status = 'MISSING';
    else if (user.federationId !== entry.federationId) status = 'MISMATCH';
    else status = 'MATCH';
    findings.push({userKey: key, status});
  }
  for (const [key] of users) if (!byId.has(key)) findings.push({userKey: key, status: duplicateSnapshotIds.has(key) ? 'AMBIGUOUS' : 'UNMANAGED'});
  findings.sort((a,b) => a.userKey.localeCompare(b.userKey));
  const counts = Object.fromEntries([...new Set(findings.map(f=>f.status))].sort().map(s=>[s, findings.filter(f=>f.status===s).length]));
  return {schemaVersion:1, orgKey:baseline.orgKey, mode:'READ_ONLY', verdict: findings.every(f=>f.status==='MATCH') ? 'PASS' : 'REVIEW_REQUIRED', counts, findings};
}
function loadJson(path) { return JSON.parse(fs.readFileSync(path, 'utf8')); }
module.exports = {reconcile, loadJson};
