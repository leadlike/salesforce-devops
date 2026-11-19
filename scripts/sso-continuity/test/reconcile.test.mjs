import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcile, STATUS } from '../src/reconcile.mjs';
import { Unverifiable } from '../src/errors.mjs';
import { baseline, snapshot, id, user } from '../testkit/builders.mjs';

const statusOf = (result, userKey) => result.findings.find((f) => f.userKey === userKey)?.status;
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof Unverifiable && e.code === code, `expected ${code}`);
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

test('fixtures produce one finding of each reviewable kind', () => {
  const result = reconcile(fixture('baseline.json'), fixture('snapshot.json'));
  assert.equal(result.verdict, 'REVIEW_REQUIRED');
  assert.equal(result.mode, 'READ_ONLY');
  assert.deepEqual(result.counts, { INACTIVE: 1, MATCH: 1, MISMATCH: 1, MISSING: 1 });
});

test('valid matches pass', () => {
  const r = reconcile(baseline([id('a', 'fa'), id('b', 'fb')]), snapshot([user('a', 'fa'), user('b', 'fb')]));
  assert.equal(r.verdict, 'PASS');
  assert.deepEqual(r.counts, { MATCH: 2 });
});

test('missing Federation ID (null, empty string, whitespace, absent field)', () => {
  for (const value of [null, '', '   ']) {
    const r = reconcile(baseline([id('a', 'fa')]), snapshot([user('a', value)]));
    assert.equal(statusOf(r, 'a'), STATUS.MISSING);
    assert.equal(r.verdict, 'REVIEW_REQUIRED');
  }
  const absent = reconcile(baseline([id('a', 'fa')]), snapshot([{ userKey: 'a', active: true }]));
  assert.equal(statusOf(absent, 'a'), STATUS.MISSING);
});

test('incorrect Federation ID is a mismatch, and comparison is exact and case-sensitive', () => {
  assert.equal(statusOf(reconcile(baseline([id('a', 'fa')]), snapshot([user('a', 'other')])), 'a'), STATUS.MISMATCH);
  assert.equal(statusOf(reconcile(baseline([id('a', 'fa')]), snapshot([user('a', 'FA')])), 'a'), STATUS.MISMATCH);
  assert.equal(statusOf(reconcile(baseline([id('a', 'fa')]), snapshot([user('a', 'fa ')])), 'a'), STATUS.MISMATCH);
});

test('duplicate actual Federation ID across two users', () => {
  const r = reconcile(baseline([id('a', 'fa'), id('b', 'fb')]), snapshot([user('a', 'fa'), user('b', 'fa')]));
  assert.equal(statusOf(r, 'a'), STATUS.DUPLICATE_ACTUAL);
  assert.equal(statusOf(r, 'b'), STATUS.DUPLICATE_ACTUAL);
  assert.equal(r.verdict, 'REVIEW_REQUIRED');
});

test('duplicate expected Federation ID in the baseline is ambiguous', () => {
  const r = reconcile(baseline([id('a', 'same'), id('b', 'same')]), snapshot([user('a', 'same'), user('b', 'same')]));
  assert.equal(statusOf(r, 'a'), STATUS.AMBIGUOUS);
  assert.equal(statusOf(r, 'b'), STATUS.AMBIGUOUS);
});

test('duplicate correlation key in the baseline or snapshot is ambiguous', () => {
  const b = reconcile(baseline([id('a', 'fa'), id('a', 'fb')]), snapshot([user('a', 'fa')]));
  assert.equal(statusOf(b, 'a'), STATUS.AMBIGUOUS);
  const s = reconcile(baseline([id('a', 'fa')]), snapshot([user('a', 'fa'), user('a', 'fa')]));
  assert.equal(statusOf(s, 'a'), STATUS.AMBIGUOUS);
  const u = reconcile(baseline([id('a', 'fa')]), snapshot([user('a', 'fa'), user('z', 'fz'), user('z', 'fy')]));
  assert.equal(statusOf(u, 'z'), STATUS.AMBIGUOUS);
});

test('inactive, missing and unmanaged users', () => {
  const r = reconcile(baseline([id('a', 'fa'), id('b', 'fb')]), snapshot([user('a', 'fa', false), user('extra', 'fx')]));
  assert.equal(statusOf(r, 'a'), STATUS.INACTIVE);
  assert.equal(statusOf(r, 'b'), STATUS.USER_NOT_FOUND);
  assert.equal(statusOf(r, 'extra'), STATUS.UNMANAGED);
});

test('an unmanaged user alone downgrades an otherwise clean result', () => {
  const r = reconcile(baseline([id('a', 'fa')]), snapshot([user('a', 'fa'), user('other', 'fo')]));
  assert.equal(r.verdict, 'REVIEW_REQUIRED');
  assert.deepEqual(r.counts, { MATCH: 1, UNMANAGED: 1 });
});

test('an empty baseline is unverifiable, never a vacuous PASS (regression)', () => {
  throwsCode(() => reconcile(baseline([]), snapshot([])), 'E_BASELINE_EMPTY');
  throwsCode(() => reconcile(baseline([]), snapshot([user('a', 'fa')])), 'E_BASELINE_EMPTY');
});

test('cross-org inputs are unverifiable, including case-only differences', () => {
  throwsCode(() => reconcile(baseline([id('a', 'fa')], 'org-a'), snapshot([user('a', 'fa')], 'org-b')), 'E_ORG_MISMATCH');
  throwsCode(() => reconcile(baseline([id('a', 'fa')], 'org-a'), snapshot([user('a', 'fa')], 'ORG-A')), 'E_ORG_MISMATCH');
});

test('incomplete snapshots are unverifiable (regression)', () => {
  const b = baseline([id('a', 'fa')]);
  throwsCode(() => reconcile(b, snapshot([user('a', 'fa')], 'fictional-qa', { done: false })), 'E_SNAPSHOT_INCOMPLETE');
  throwsCode(() => reconcile(b, snapshot([user('a', 'fa')], 'fictional-qa', { totalSize: 5000 })), 'E_SNAPSHOT_INCOMPLETE');
  assert.equal(reconcile(b, snapshot([user('a', 'fa')], 'fictional-qa', { totalSize: 1, done: true })).verdict, 'PASS');
});

test('user keys named like Object.prototype members are ordinary data or are rejected, never special', () => {
  const b = JSON.parse('{"schemaVersion":1,"orgKey":"o","identities":[{"userKey":"constructor","federationId":"f2"},{"userKey":"toString","federationId":"f3"},{"userKey":"hasOwnProperty","federationId":"f4"}]}');
  const s = JSON.parse('{"schemaVersion":1,"orgKey":"o","users":[{"userKey":"constructor","active":true,"federationId":"f2"},{"userKey":"toString","active":true,"federationId":"f3"},{"userKey":"hasOwnProperty","active":true,"federationId":"f4"}]}');
  const r = reconcile(b, s);
  assert.equal(r.verdict, 'PASS');
  assert.deepEqual(r.counts, { MATCH: 3 });
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(r.counts), Object.prototype);
  // "__proto__" cannot start a user key, so it is refused outright.
  const evil = JSON.parse('{"schemaVersion":1,"orgKey":"o","identities":[{"userKey":"__proto__","federationId":"f1"}]}');
  throwsCode(() => reconcile(evil, snapshot([])), 'E_SCHEMA');
  const polluting = JSON.parse('{"schemaVersion":1,"orgKey":"o","identities":[{"userKey":"a","federationId":"f"}],"__proto__":{"polluted":true}}');
  throwsCode(() => reconcile(polluting, snapshot([user('a', 'f')], 'o')), 'E_SCHEMA'); // own "__proto__" field is an unknown field
  assert.equal(({}).polluted, undefined);
});

test('output is deterministic and independent of input order', () => {
  const ids = ['b-2', 'B-1', 'a-1', 'z-0', 'Z-9'].map((k) => id(k, `f-${k}`));
  const users = ids.map((e) => user(e.userKey, e.federationId));
  const forward = JSON.stringify(reconcile(baseline(ids), snapshot(users)));
  const reversed = JSON.stringify(reconcile(baseline([...ids].reverse()), snapshot([...users].reverse())));
  assert.equal(forward, reversed);
  assert.deepEqual(JSON.parse(forward).findings.map((f) => f.userKey), ['B-1', 'Z-9', 'a-1', 'b-2', 'z-0']);
});

test('Federation ID values never appear in the result', () => {
  const secret = 'SECRET-FEDERATION-VALUE-42';
  const r = reconcile(baseline([id('a', secret)]), snapshot([user('a', `${secret}-different`), user('x', 'ANOTHER-SECRET-77')]));
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});

test('inputs are not modified', () => {
  const b = baseline([id('a', 'fa')]);
  const s = snapshot([user('a', 'fa')]);
  const before = JSON.stringify([b, s]);
  reconcile(b, s);
  assert.equal(JSON.stringify([b, s]), before);
});

test('only an all-MATCH result can pass', () => {
  const cases = [
    [baseline([id('a', 'fa')]), snapshot([user('a', null)])],
    [baseline([id('a', 'fa')]), snapshot([user('a', 'x')])],
    [baseline([id('a', 'fa')]), snapshot([user('a', 'fa', false)])],
    [baseline([id('a', 'fa')]), snapshot([user('b', 'fa')])],
  ];
  for (const [b, s] of cases) assert.notEqual(reconcile(b, s).verdict, 'PASS');
});
