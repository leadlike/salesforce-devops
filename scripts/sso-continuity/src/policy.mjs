// Live-run policy: which org is expected and how users are correlated.
//
// The policy is security-relevant. It decides which org the audit may read and which
// Salesforce field supplies the approved correlation key. Keep the real policy in a
// protected repository and pin its SHA-256 (see --policy-sha256), exactly as for the
// Org Guard policy. An unreviewed pull request must not supply both the policy and
// the baseline.

import { Unverifiable } from './errors.mjs';
import { readJsonFileWithDigest } from './json-input.mjs';

const ORG_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ORG_ID = /^00D[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;
// Only the standard employee number or an explicit custom field may carry the key.
// E-mail, username, name, alias and Federation ID fields are deliberately not options.
const KEY_FIELD = /^(EmployeeNumber|[A-Za-z][A-Za-z0-9_]{0,60}__c)$/;
const USER_TYPE = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TARGET_ALIAS = /^[A-Za-z0-9._@-]{1,100}$/;

const bad = (message) => { throw new Unverifiable('E_POLICY', message); };
const only = (obj, allowed, what) => {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(`${what} contains an unsupported field`);
};

/** Org IDs are compared on their 15-character, case-sensitive canonical form. */
export const canonicalOrgId = (id) => id.slice(0, 15);

export function validatePolicy(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) bad('policy must be an object');
  if (!Object.hasOwn(doc, 'schemaVersion') || doc.schemaVersion !== 1) bad('policy has an unsupported or missing schemaVersion');
  only(doc, ['schemaVersion', 'orgKey', 'expectedOrgId', 'correlation', 'includedUserTypes'], 'policy');
  if (typeof doc.orgKey !== 'string' || !ORG_KEY.test(doc.orgKey)) bad('policy has an invalid orgKey');
  if (typeof doc.expectedOrgId !== 'string' || !ORG_ID.test(doc.expectedOrgId)) bad('policy has an invalid expectedOrgId');
  const c = doc.correlation;
  if (c === null || typeof c !== 'object' || Array.isArray(c)) bad('policy correlation must be an object');
  only(c, ['field'], 'policy correlation');
  if (typeof c.field !== 'string' || !KEY_FIELD.test(c.field)) bad('policy correlation field must be EmployeeNumber or a custom field ending in __c');
  const types = doc.includedUserTypes;
  if (!Array.isArray(types) || types.length < 1 || types.length > 10) bad('policy includedUserTypes must list 1 to 10 user types');
  const seen = new Set();
  for (const t of types) {
    if (typeof t !== 'string' || !USER_TYPE.test(t)) bad('policy includedUserTypes contains an invalid value');
    if (seen.has(t)) bad('policy includedUserTypes contains a duplicate');
    seen.add(t);
  }
  return { orgKey: doc.orgKey, expectedOrgId: doc.expectedOrgId, correlationField: c.field, includedUserTypes: [...types] };
}

/** Load a policy file and, when a digest is given, require the exact bytes to match it. */
export function loadPolicy(path, pinSha256) {
  if (pinSha256 !== undefined && (typeof pinSha256 !== 'string' || !SHA256.test(pinSha256))) {
    throw new Unverifiable('E_POLICY_PIN', 'the policy pin must be 64 lowercase hexadecimal characters');
  }
  const { value, sha256 } = readJsonFileWithDigest(path);
  if (pinSha256 !== undefined && sha256 !== pinSha256) {
    throw new Unverifiable('E_POLICY_PIN', 'the policy does not match its pinned SHA-256 digest');
  }
  return { policy: validatePolicy(value), sha256 };
}

export function validateTargetOrg(alias) {
  if (typeof alias !== 'string' || !TARGET_ALIAS.test(alias) || alias.startsWith('-')) {
    throw new Unverifiable('E_TARGET_ORG', 'the target org must be an alias or username of safe characters');
  }
  return alias;
}
