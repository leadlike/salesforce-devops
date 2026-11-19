import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnlyQuery, organizationQuery, usersQuery, samlConfigQuery, authProviderQuery } from '../src/queries.mjs';
import { runQuery, queryArgs, spawnPlan, windowsCommandLine } from '../src/sf-runner.mjs';
import { Unverifiable } from '../src/errors.mjs';
import { fakeSf, queryResponse } from '../testkit/fake-sf.mjs';

const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof Unverifiable && e.code === code, `expected ${code}`);
const ok = (stdout, status = 0) => () => ({ status, stdout, timedOut: false });
const run = (runner) => runQuery({ runner, targetOrg: 'qa', soql: organizationQuery() });

test('every generated query passes the read-only gate and is a bare SELECT', () => {
  for (const q of [organizationQuery(), usersQuery('EmployeeNumber'), usersQuery('Employee_Key__c'), samlConfigQuery(), authProviderQuery()]) {
    assert.match(q, /^SELECT [A-Za-z0-9_, ]+ FROM (User|Organization|SamlSsoConfig|AuthProvider)$/);
    assert.equal(assertReadOnlyQuery(q), q);
    assert.ok(!/['"();=<>*]|\bWHERE\b|\bLIMIT\b|\bUPDATE\b|\bDELETE\b/i.test(q));
  }
});

test('the gate rejects anything that is not a plain allow-listed SELECT', () => {
  const bad = [
    'DELETE FROM User', 'UPDATE User SET IsActive = false', 'SELECT Id FROM User WHERE Id = 1', "SELECT Id FROM User WHERE Name = 'x'",
    'SELECT Id FROM Account', 'SELECT Id FROM User; DELETE FROM User', 'SELECT Id FROM User LIMIT 1', 'SELECT (SELECT Id FROM Contacts) FROM User',
    'SELECT FROM User', 'SELECT Id, FROM User', 'select Id from User', 'SELECT Id FROM User ', ' SELECT Id FROM User',
    'SELECT ConsumerSecret FROM AuthProvider', 'SELECT DeveloperName, ConsumerKey FROM AuthProvider', 'SELECT Id FROM User\nDELETE', '', null, undefined, 5,
  ];
  for (const q of bad) rejects(() => assertReadOnlyQuery(q), 'E_INTERNAL');
});

test('the correlation field is validated again when the query is built', () => {
  for (const f of ['Email', 'Id, Password', 'EmployeeNumber FROM User; DELETE', '', null]) rejects(() => usersQuery(f), 'E_POLICY');
});

test('no query selects a secret-bearing field', () => {
  const all = [organizationQuery(), usersQuery('EmployeeNumber'), samlConfigQuery(), authProviderQuery()].join(' ');
  assert.ok(!/ConsumerKey|ConsumerSecret|Password|SecurityToken/.test(all));
});

test('the only CLI command that can be built is `sf data query`', () => {
  const args = queryArgs('qa', organizationQuery());
  assert.deepEqual(args, ['data', 'query', '--target-org', 'qa', '--query', 'SELECT Id FROM Organization', '--json']);
  rejects(() => queryArgs('--json', organizationQuery()), 'E_TARGET_ORG');
  rejects(() => queryArgs('qa', 'DELETE FROM User'), 'E_INTERNAL');
});

test('Windows command lines quote what needs quoting and refuse the rest', () => {
  const line = windowsCommandLine('sf', queryArgs('qa', usersQuery('EmployeeNumber')));
  assert.equal(line, 'sf data query --target-org qa --query "SELECT EmployeeNumber, IsActive, FederationIdentifier, UserType FROM User" --json');
  for (const bad of ['a&b', 'a|b', 'a"b', 'a%b%', 'a^b', 'a(b)', "a'b", 'a;b', 'a\nb']) rejects(() => windowsCommandLine('sf', [bad]), 'E_CLI_FAILED');
  assert.equal(spawnPlan(['data'], 'win32').shell, true);
  assert.equal(spawnPlan(['data'], 'linux').shell, false);
  assert.deepEqual(spawnPlan(['data'], 'linux').argv, ['data']);
});

test('a complete successful result returns its records', () => {
  const runner = fakeSf({ Organization: queryResponse([{ Id: '00DFICTIONAL000' }]) });
  assert.deepEqual(run(runner), [{ Id: '00DFICTIONAL000' }]);
  assert.equal(runner.calls.length, 1);
});

test('an empty but complete result is valid (zero records)', () => {
  assert.deepEqual(run(fakeSf({ Organization: queryResponse([]) })), []);
});

test('every failure mode is unverifiable and has a stable code', () => {
  const doc = (o) => JSON.stringify(o);
  const cases = {
    E_CLI_TIMEOUT: () => ({ status: null, stdout: '', timedOut: true }),
    E_CLI_UNAVAILABLE: () => ({ status: null, stdout: '', timedOut: false, spawnError: 'ENOENT' }),
    E_CLI_FAILED: [ok('', 1), ok(doc({ status: 1, message: 'x' }), 1), ok(doc({ status: 1, result: {} }), 0), ok('{"status":0,"result":{"records":[]}}', 1), ok('not json', 1), ok('null', 0), ok(doc([]), 0)],
    E_CLI_OUTPUT: [ok('not json', 0), ok(doc({ status: 0 }), 0), ok(doc({ status: 0, result: null }), 0), ok(doc({ status: 0, result: { records: 'x', totalSize: 0 } }), 0), ok(doc({ status: 0, result: { records: [null], totalSize: 1 } }), 0), ok(doc({ status: 0, result: { records: [[]], totalSize: 1 } }), 0)],
    E_QUERY_INCOMPLETE: [ok(doc({ status: 0, result: { records: [{}], totalSize: 5, done: true } }), 0), ok(doc({ status: 0, result: { records: [{}], totalSize: 1, done: false } }), 0), ok(doc({ status: 0, result: { records: [{}] } }), 0), ok(doc({ status: 0, result: { records: [], totalSize: '0' } }), 0)],
  };
  for (const [code, runners] of Object.entries(cases)) {
    for (const runner of [runners].flat()) rejects(() => run(runner), code);
  }
});

test('raw CLI output and stderr are never copied into an error', () => {
  const secret = 'SECRET-CLI-OUTPUT-99';
  const noisy = [ok(`${secret} not json`, 0), ok(JSON.stringify({ status: 1, message: secret }), 1), ok(JSON.stringify({ status: 0, result: { records: [{ note: secret }, 5], totalSize: 2 } }), 0)];
  for (const runner of noisy) {
    try {
      run(runner);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof Unverifiable);
      assert.ok(!e.message.includes(secret) && !String(e.stack).includes(secret));
    }
  }
});

test('the runner is called with a timeout and the exact argument vector', () => {
  let seen;
  runQuery({ runner: (args, timeoutMs) => { seen = { args, timeoutMs }; return { status: 0, stdout: JSON.stringify(queryResponse([])), timedOut: false }; }, targetOrg: 'qa', soql: organizationQuery(), timeoutMs: 1234 });
  assert.equal(seen.timeoutMs, 1234);
  assert.equal(seen.args[0], 'data');
  assert.equal(seen.args[1], 'query');
});
