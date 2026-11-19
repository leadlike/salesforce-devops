// Strict, closed schemas for the two input documents (schemaVersion 1).
//
// Unknown fields are rejected rather than ignored: a misspelled or smuggled field
// must not be silently dropped from a security baseline. Identifiers are restricted
// to a safe character set so that they cannot spoof terminal or log output, and
// every length is bounded.
//
// Validation returns fresh copies; callers' objects are never modified.

import { Unverifiable } from './errors.mjs';
import { DEFAULT_LIMITS } from './limits.mjs';

const ORG_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USER_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Forbidden in Federation IDs: control characters, invisible and bidirectional
// formatting characters, line/paragraph separators, the byte order mark and the
// replacement character (which signals that a file was not valid UTF-8).
// Expressed as numeric ranges so the source contains no invisible characters.
const FORBIDDEN_RANGES = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff], [0xfffd, 0xfffd],
];
const hasForbiddenChar = (text) => {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (FORBIDDEN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return true;
  }
  return false;
};
const MAX_FEDERATION_ID_LENGTH = 512;

const fail = (message) => { throw new Unverifiable('E_SCHEMA', message); };

function plainObject(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${what} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${what} must be a plain object`);
  return value;
}

function onlyKeys(obj, allowed, what) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${what} contains an unsupported field`);
  }
}

function schemaVersion(doc, what) {
  if (!Object.hasOwn(doc, 'schemaVersion') || doc.schemaVersion !== 1) {
    throw new Unverifiable('E_SCHEMA_VERSION', `${what} has an unsupported or missing schemaVersion`);
  }
}

function orgKey(doc, what) {
  if (typeof doc.orgKey !== 'string' || !ORG_KEY.test(doc.orgKey)) fail(`${what} has an invalid orgKey`);
  return doc.orgKey;
}

function federationIdText(value, what) {
  if (typeof value !== 'string') fail(`${what} federationId must be a string`);
  if (value.length > MAX_FEDERATION_ID_LENGTH) fail(`${what} federationId is too long`);
  if (hasForbiddenChar(value)) fail(`${what} federationId contains forbidden characters`);
  return value;
}

/** Validate the approved baseline. Returns { orgKey, identities: [{ userKey, federationId }] }. */
export function validateBaseline(doc, limits = DEFAULT_LIMITS) {
  plainObject(doc, 'baseline');
  schemaVersion(doc, 'baseline');
  onlyKeys(doc, ['schemaVersion', 'orgKey', 'identities'], 'baseline');
  const key = orgKey(doc, 'baseline');
  if (!Array.isArray(doc.identities)) fail('baseline identities must be an array');
  // A baseline with no identities would make every comparison vacuously true.
  if (doc.identities.length === 0) throw new Unverifiable('E_BASELINE_EMPTY', 'baseline contains no identities');
  if (doc.identities.length > limits.maxIdentities) throw new Unverifiable('E_LIMIT_RECORDS', 'baseline exceeds the record limit');
  const identities = doc.identities.map((entry) => {
    plainObject(entry, 'baseline identity');
    onlyKeys(entry, ['userKey', 'federationId'], 'baseline identity');
    if (typeof entry.userKey !== 'string' || !USER_KEY.test(entry.userKey)) fail('baseline identity has an invalid userKey');
    const federationId = federationIdText(entry.federationId, 'baseline identity');
    // An approved baseline must be exact: padding would create an invisible mismatch.
    if (federationId.length === 0 || federationId !== federationId.trim()) fail('baseline identity federationId must be non-empty and not padded');
    return { userKey: entry.userKey, federationId };
  });
  return { orgKey: key, identities };
}

/**
 * Validate the snapshot. Returns { orgKey, users: [{ userKey, active, federationId }], declaredSize, done }.
 * `federationId` is a string, or null when the org holds no value.
 */
export function validateSnapshot(doc, limits = DEFAULT_LIMITS) {
  plainObject(doc, 'snapshot');
  schemaVersion(doc, 'snapshot');
  onlyKeys(doc, ['schemaVersion', 'orgKey', 'users', 'totalSize', 'done'], 'snapshot');
  const key = orgKey(doc, 'snapshot');
  if (!Array.isArray(doc.users)) fail('snapshot users must be an array');
  if (doc.users.length > limits.maxUsers) throw new Unverifiable('E_LIMIT_RECORDS', 'snapshot exceeds the record limit');
  let declaredSize = null;
  if (Object.hasOwn(doc, 'totalSize')) {
    if (!Number.isSafeInteger(doc.totalSize) || doc.totalSize < 0) fail('snapshot totalSize must be a non-negative integer');
    declaredSize = doc.totalSize;
  }
  let done = null;
  if (Object.hasOwn(doc, 'done')) {
    if (typeof doc.done !== 'boolean') fail('snapshot done must be a boolean');
    done = doc.done;
  }
  const users = doc.users.map((user) => {
    plainObject(user, 'snapshot user');
    onlyKeys(user, ['userKey', 'active', 'federationId'], 'snapshot user');
    if (typeof user.userKey !== 'string' || !USER_KEY.test(user.userKey)) fail('snapshot user has an invalid userKey');
    if (typeof user.active !== 'boolean') fail('snapshot user active must be a boolean');
    const raw = Object.hasOwn(user, 'federationId') ? user.federationId : null;
    const federationId = raw === null ? null : federationIdText(raw, 'snapshot user');
    return { userKey: user.userKey, active: user.active, federationId };
  });
  return { orgKey: key, users, declaredSize, done };
}
