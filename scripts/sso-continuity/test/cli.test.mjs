import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main, EXIT } from '../src/cli.mjs';
import { runCli, baseline, snapshot, id, user } from '../testkit/builders.mjs';

const fixturePath = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const good = () => [baseline([id('a', 'fa')]), snapshot([user('a', 'fa')])];

test('exit 0 only when every identity matches', () => {
  const r = runCli(good());
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).verdict, 'PASS');
  assert.equal(r.stderr, '');
});

test('exit 2 when findings require review, and the result is on stdout', () => {
  const r = runCli([baseline([id('a', 'fa')]), snapshot([user('a', 'other')])]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).verdict, 'REVIEW_REQUIRED');
});

test('the shipped fixtures exit 2 through the real process', () => {
  const r = runCli([], { rawArgs: [fixturePath('baseline.json'), fixturePath('snapshot.json')] });
  assert.equal(r.status, 2);
  assert.deepEqual(JSON.parse(r.stdout).counts, { INACTIVE: 1, MATCH: 1, MISMATCH: 1, MISSING: 1 });
});

test('exit 3 for every unverifiable condition; stdout stays empty', () => {
  const [b, s] = good();
  const cases = {
    'no arguments': { docs: [], rawArgs: [] },
    'one argument': { docs: [b], rawArgs: undefined, one: true },
    'three arguments': { docs: [b, s, s] },
    'missing file': { docs: [], rawArgs: ['/nonexistent/a.json', '/nonexistent/b.json'] },
    'invalid JSON': { docs: ['{ not json', JSON.stringify(s)] },
    'empty file': { docs: ['', JSON.stringify(s)] },
    'empty baseline': { docs: [baseline([]), s] },
    'cross-org': { docs: [b, snapshot([user('a', 'fa')], 'another-org')] },
    'bad schema version': { docs: [{ ...b, schemaVersion: 9 }, s] },
    'unknown field': { docs: [{ ...b, extra: 1 }, s] },
    'duplicate JSON key': { docs: ['{"schemaVersion":1,"schemaVersion":1,"orgKey":"o","identities":[]}', JSON.stringify(s)] },
    'incomplete snapshot': { docs: [b, { ...s, done: false }] },
    'top-level array': { docs: ['[]', JSON.stringify(s)] },
    'top-level null': { docs: ['null', JSON.stringify(s)] },
  };
  for (const [name, c] of Object.entries(cases)) {
    const r = c.one ? runCli([b]) : runCli(c.docs, c.rawArgs ? { rawArgs: c.rawArgs } : {});
    assert.equal(r.status, 3, `${name}: expected exit 3, got ${r.status}`);
    assert.equal(r.stdout, '', `${name}: stdout must be empty`);
    assert.match(r.stderr, /^UNVERIFIABLE \[E_[A-Z_]+\]: /, name);
  }
});

test('an unrecognized option is treated as a file name and fails closed', () => {
  assert.equal(runCli([], { rawArgs: ['--help', '--force'] }).status, 3);
});

test('error output never contains input values (sensitive value suppression)', () => {
  const secret = 'SECRET-FEDERATION-VALUE-42';
  const bad = `{"schemaVersion":1,"orgKey":"o","identities":[{"userKey":"a","federationId":"${secret}" oops}]}`;
  const r = runCli([bad, JSON.stringify(snapshot([]))]);
  assert.equal(r.status, 3);
  assert.ok(!r.stderr.includes(secret) && !r.stdout.includes(secret));
});

test('successful output never contains Federation ID values', () => {
  const secret = 'SECRET-FEDERATION-VALUE-42';
  const r = runCli([baseline([id('a', secret)]), snapshot([user('a', `${secret}x`), user('b', 'ANOTHER-SECRET')])]);
  assert.equal(r.status, 2);
  assert.ok(!r.stdout.includes('SECRET'));
  assert.ok(!r.stderr.includes('SECRET'));
});

test('unexpected internal errors exit 3 with a fixed message and no leaked detail', () => {
  const secret = 'SECRET-INTERNAL-DETAIL';
  let out = '';
  let err = '';
  const code = main(['a', 'b'], {
    read: () => { throw new Error(`boom ${secret}`); },
    out: (s) => { out += s; },
    err: (s) => { err += s; },
  });
  assert.equal(code, EXIT.UNVERIFIABLE);
  assert.equal(out, '');
  assert.match(err, /E_INTERNAL/);
  assert.ok(!err.includes(secret));
});

test('a failure while writing output cannot produce success', () => {
  const [b, s] = good();
  const code = main(['a', 'b'], {
    read: (p) => (p === 'a' ? b : s),
    out: () => { throw new Error('EPIPE'); },
    err: () => {},
  });
  assert.equal(code, EXIT.UNVERIFIABLE);
});

test('exit codes are the documented constants', () => {
  assert.deepEqual({ ...EXIT }, { PASS: 0, REVIEW_REQUIRED: 2, UNVERIFIABLE: 3 });
});

test('output is byte-identical across runs (determinism)', () => {
  const docs = [
    baseline(['z', 'a', 'M', 'b'].map((k) => id(k, `f-${k}`))),
    snapshot(['b', 'M', 'a', 'q'].map((k) => user(k, `f-${k}`))),
  ];
  assert.equal(runCli(docs).stdout, runCli(docs).stdout);
});

test('large output is delivered completely through a pipe (regression)', () => {
  const count = 20_000;
  const users = Array.from({ length: count }, (_, i) => user(`u-${i}`, `f-${i}`));
  const r = runCli([baseline([id('u-0', 'f-0')]), snapshot(users)]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).findings.length, count); // truncated output would not parse
});

test('the CLI source contains no write, network or process-spawning capability', () => {
  for (const file of ['cli.mjs', 'reconcile.mjs', 'schema.mjs', 'json-input.mjs']) {
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.ok(!/node:(child_process|net|http|https|dgram|tls|dns|worker_threads)|\bfetch\(|writeFile|appendFile|unlink|rmSync|process\.env/.test(text), `${file} must stay read-only and offline`);
  }
});
