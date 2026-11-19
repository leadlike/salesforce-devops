import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/reconcile.mjs';
import { validateBaseline, validateSnapshot } from '../src/schema.mjs';
import { Unverifiable } from '../src/errors.mjs';
import { DEFAULT_LIMITS } from '../src/limits.mjs';
import { baseline, snapshot, id, user } from '../testkit/builders.mjs';

const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof Unverifiable && e.code === code, `expected ${code}`);
const cp = (n) => String.fromCodePoint(n);

test('unsupported, missing or non-numeric schemaVersion', () => {
  for (const v of [2, 0, '1', null, undefined, 1.5]) {
    const b = { ...baseline([id('a', 'fa')]), schemaVersion: v };
    rejects(() => validateBaseline(b), 'E_SCHEMA_VERSION');
    rejects(() => validateSnapshot({ ...snapshot([]), schemaVersion: v }), 'E_SCHEMA_VERSION');
  }
  const noVersion = baseline([id('a', 'fa')]);
  delete noVersion.schemaVersion;
  rejects(() => validateBaseline(noVersion), 'E_SCHEMA_VERSION');
});

test('unsafe top-level types', () => {
  for (const doc of [null, undefined, 42, 'text', true, [], [[]]]) {
    rejects(() => validateBaseline(doc), 'E_SCHEMA');
    rejects(() => validateSnapshot(doc), 'E_SCHEMA');
  }
});

test('non-plain objects are rejected', () => {
  rejects(() => validateBaseline(Object.assign(Object.create({ inherited: 1 }), baseline([id('a', 'fa')]))), 'E_SCHEMA');
  rejects(() => validateBaseline(new Map()), 'E_SCHEMA');
});

test('unknown fields are rejected, not ignored (regression)', () => {
  rejects(() => validateBaseline({ ...baseline([id('a', 'fa')]), extra: 1 }), 'E_SCHEMA');
  rejects(() => validateBaseline(baseline([{ userKey: 'a', federationId: 'fa', note: 'x' }])), 'E_SCHEMA');
  rejects(() => validateBaseline(baseline([{ userkey: 'a', federationId: 'fa' }])), 'E_SCHEMA'); // misspelled key
  rejects(() => validateSnapshot({ ...snapshot([]), extra: 1 }), 'E_SCHEMA');
  rejects(() => validateSnapshot(snapshot([{ userKey: 'a', active: true, federationId: null, email: 'x@example.invalid' }])), 'E_SCHEMA');
});

test('arrays and entries must have the right types', () => {
  rejects(() => validateBaseline({ ...baseline([]), identities: {} }), 'E_SCHEMA');
  rejects(() => validateBaseline(baseline(['a'])), 'E_SCHEMA');
  rejects(() => validateBaseline(baseline([null])), 'E_SCHEMA');
  rejects(() => validateSnapshot({ ...snapshot([]), users: 'none' }), 'E_SCHEMA');
  rejects(() => validateSnapshot(snapshot([[]])), 'E_SCHEMA');
});

test('empty, malformed and wrongly typed identifiers', () => {
  for (const key of ['', ' ', 'a b', ' a', 'a ', 'a\n', '-a', '.a', 'a/b', 'a@b', 5, null, {}, 'x'.repeat(129)]) {
    rejects(() => validateBaseline(baseline([{ userKey: key, federationId: 'fa' }])), 'E_SCHEMA');
    rejects(() => validateSnapshot(snapshot([{ userKey: key, active: true, federationId: null }])), 'E_SCHEMA');
  }
  for (const org of ['', ' ', 'a b', 5, null, 'x'.repeat(65), '../x']) {
    rejects(() => validateBaseline({ ...baseline([id('a', 'fa')]), orgKey: org }), 'E_SCHEMA');
  }
});

test('baseline Federation IDs must be exact: non-empty, unpadded, strings', () => {
  for (const value of ['', ' ', ' fa', 'fa ', '\tfa', 5, null, undefined, {}, []]) {
    rejects(() => validateBaseline(baseline([{ userKey: 'a', federationId: value }])), 'E_SCHEMA');
  }
});

test('snapshot users: active must be boolean, federationId string or null', () => {
  for (const active of ['true', 1, 0, null, undefined]) {
    rejects(() => validateSnapshot(snapshot([{ userKey: 'a', active, federationId: null }])), 'E_SCHEMA');
  }
  for (const value of [5, true, {}, [], 'x'.repeat(513)]) {
    rejects(() => validateSnapshot(snapshot([{ userKey: 'a', active: true, federationId: value }])), 'E_SCHEMA');
  }
  assert.equal(validateSnapshot(snapshot([{ userKey: 'a', active: true }])).users[0].federationId, null);
});

test('invisible, bidirectional and control characters in Federation IDs are rejected (regression)', () => {
  const bad = [0x00, 0x07, 0x1b, 0x7f, 0x85, 0xad, 0x200b, 0x200e, 0x202e, 0x2028, 0x2066, 0xfeff, 0xfffd];
  for (const code of bad) {
    const value = `fa${cp(code)}b`;
    rejects(() => validateBaseline(baseline([{ userKey: 'a', federationId: value }])), 'E_SCHEMA');
    rejects(() => validateSnapshot(snapshot([{ userKey: 'a', active: true, federationId: value }])), 'E_SCHEMA');
  }
});

test('a bidirectional override cannot enter output through a user key (regression)', () => {
  rejects(() => validateBaseline(baseline([{ userKey: `${cp(0x202e)}evil`, federationId: 'fa' }])), 'E_SCHEMA');
});

test('ordinary international Federation IDs are accepted', () => {
  const value = 'josé.garcía@example.invalid';
  assert.equal(reconcile(baseline([id('a', value)]), snapshot([user('a', value)])).verdict, 'PASS');
});

test('record limits are enforced and report UNVERIFIABLE', () => {
  const tight = { ...DEFAULT_LIMITS, maxIdentities: 2, maxUsers: 2 };
  rejects(() => validateBaseline(baseline([id('a', '1'), id('b', '2'), id('c', '3')]), tight), 'E_LIMIT_RECORDS');
  rejects(() => validateSnapshot(snapshot([user('a', '1'), user('b', '2'), user('c', '3')]), tight), 'E_LIMIT_RECORDS');
  assert.equal(validateBaseline(baseline([id('a', '1'), id('b', '2')]), tight).identities.length, 2);
});

test('totalSize and done are validated', () => {
  for (const totalSize of [-1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
    rejects(() => validateSnapshot({ ...snapshot([]), totalSize }), 'E_SCHEMA');
  }
  rejects(() => validateSnapshot({ ...snapshot([]), done: 'yes' }), 'E_SCHEMA');
});

test('validation returns copies and never mutates the input', () => {
  const doc = baseline([id('a', 'fa')]);
  const frozen = JSON.stringify(doc);
  const out = validateBaseline(doc);
  out.identities[0].federationId = 'changed';
  assert.equal(JSON.stringify(doc), frozen);
});
