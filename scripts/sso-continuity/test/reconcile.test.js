'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {reconcile, loadJson} = require('../src/reconcile');
const baseline = loadJson(require('node:path').join(__dirname,'../fixtures/baseline.json'));
const snapshot = loadJson(require('node:path').join(__dirname,'../fixtures/snapshot.json'));
const copy = x => structuredClone(x);
const status = (b,s,k) => reconcile(b,s).findings.find(x=>x.userKey===k).status;
test('fixture detects match, missing, mismatch, inactive',()=>{
 assert.deepEqual(reconcile(baseline,snapshot).counts,{INACTIVE:1,MATCH:1,MISMATCH:1,MISSING:1});
});
test('clean matching snapshot passes',()=>{
 const s=copy(snapshot); for (const u of s.users) {u.active=true;u.federationId=baseline.identities.find(i=>i.userKey===u.userKey).federationId;}
 assert.equal(reconcile(baseline,s).verdict,'PASS');
});
test('wrong organization fails closed',()=>{const s=copy(snapshot);s.orgKey='other';assert.throws(()=>reconcile(baseline,s),/Organization mismatch/);});
test('duplicate baseline user key is ambiguous',()=>{const b=copy(baseline);b.identities.push({...b.identities[0]});assert.equal(status(b,snapshot,'admin-001'),'AMBIGUOUS');});
test('duplicate expected federation id is ambiguous',()=>{const b=copy(baseline);b.identities[1].federationId='employee-101';assert.equal(status(b,snapshot,'admin-001'),'AMBIGUOUS');});
test('duplicate snapshot user key is ambiguous',()=>{const s=copy(snapshot);s.users.push({...s.users[0]});assert.equal(status(baseline,s,'admin-001'),'AMBIGUOUS');});
test('duplicate actual federation id detected',()=>{const s=copy(snapshot);s.users[1].federationId='employee-101';assert.equal(status(baseline,s,'admin-001'),'DUPLICATE_ACTUAL');});
test('unknown user is unmanaged',()=>{const s=copy(snapshot);s.users.push({userKey:'extra',active:true,federationId:'x'});assert.equal(status(baseline,s,'extra'),'UNMANAGED');});
test('missing baseline user is flagged',()=>{const s=copy(snapshot);s.users.pop();assert.equal(status(baseline,s,'admin-004'),'USER_NOT_FOUND');});
test('rejects unsupported schema',()=>{const b=copy(baseline);b.schemaVersion=2;assert.throws(()=>reconcile(b,snapshot));});
test('rejects invalid active type',()=>{const s=copy(snapshot);s.users[0].active='true';assert.throws(()=>reconcile(baseline,s));});
test('does not modify input',()=>{const b=copy(baseline),s=copy(loadJson(require('node:path').join(__dirname,'../fixtures/snapshot.json')));reconcile(b,s);assert.deepEqual(b,baseline);assert.deepEqual(s,loadJson(require('node:path').join(__dirname,'../fixtures/snapshot.json')));});
