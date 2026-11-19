import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonText, readJsonFile } from '../src/json-input.mjs';
import { Unverifiable } from '../src/errors.mjs';
import { DEFAULT_LIMITS } from '../src/limits.mjs';

const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof Unverifiable && e.code === code, `expected ${code}`);

test('valid JSON parses', () => {
  assert.deepEqual(parseJsonText('{"a":[1,{"b":null}]}'), { a: [1, { b: null }] });
});

test('invalid JSON is rejected with a fixed message that never quotes the input (regression)', () => {
  const secret = 'SECRET-FID-123';
  try {
    parseJsonText(`{"federationId":"${secret}" "x"}`);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof Unverifiable);
    assert.equal(e.code, 'E_INPUT_INVALID_JSON');
    assert.ok(!e.message.includes(secret));
    assert.ok(!String(e.stack).includes(secret));
  }
});

test('empty, truncated and non-text inputs are rejected', () => {
  for (const text of ['', '   ', '{', '{"a":', '[1,', 'undefined', 'NaN', "{'a':1}", '{"a":1,}']) {
    rejects(() => parseJsonText(text), 'E_INPUT_INVALID_JSON');
  }
  rejects(() => parseJsonText(undefined), 'E_INPUT_INVALID_JSON');
  rejects(() => parseJsonText(42), 'E_INPUT_INVALID_JSON');
});

test('duplicate object keys are rejected, including escaped spellings (regression)', () => {
  rejects(() => parseJsonText('{"userKey":"a","userKey":"b"}'), 'E_INPUT_DUPLICATE_KEY');
  rejects(() => parseJsonText('{"userKey":"a","user\\u004bey":"b"}'), 'E_INPUT_DUPLICATE_KEY');
  rejects(() => parseJsonText('{"x":[{"k":1,"k":2}]}'), 'E_INPUT_DUPLICATE_KEY');
  rejects(() => parseJsonText('{"__proto__":1,"__proto__":2}'), 'E_INPUT_DUPLICATE_KEY');
});

test('the same key in different objects is allowed, and string values that look like keys are not keys', () => {
  assert.deepEqual(parseJsonText('{"a":[{"k":1},{"k":2}]}'), { a: [{ k: 1 }, { k: 2 }] });
  assert.deepEqual(parseJsonText('{"a":"k","b":"k"}'), { a: 'k', b: 'k' });
  assert.deepEqual(parseJsonText('{"a":"x\\"y","b":"x\\"y"}'), { a: 'x"y', b: 'x"y' });
});

test('a UTF-8 byte order mark is accepted (Windows tools write one)', () => {
  assert.deepEqual(parseJsonText(`${String.fromCodePoint(0xfeff)}{"a":1}`), { a: 1 });
});

test('excessive nesting is rejected before parsing (regression)', () => {
  const deep = '['.repeat(200_000) + ']'.repeat(200_000);
  rejects(() => parseJsonText(deep), 'E_INPUT_TOO_DEEP');
  rejects(() => parseJsonText('['.repeat(DEFAULT_LIMITS.maxDepth + 1)), 'E_INPUT_TOO_DEEP');
  assert.doesNotThrow(() => parseJsonText('['.repeat(DEFAULT_LIMITS.maxDepth) + ']'.repeat(DEFAULT_LIMITS.maxDepth)));
});

test('brackets inside strings do not count as nesting', () => {
  assert.doesNotThrow(() => parseJsonText(JSON.stringify({ a: '['.repeat(1000) })));
});

test('__proto__ keys parse as data and do not pollute', () => {
  const value = parseJsonText('{"__proto__":{"polluted":true}}');
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
});

test('file reading: size limit, missing file, directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sso-json-'));
  try {
    const small = join(dir, 'small.json');
    writeFileSync(small, '{"a":1}');
    assert.deepEqual(readJsonFile(small), { a: 1 });
    rejects(() => readJsonFile(small, { ...DEFAULT_LIMITS, maxFileBytes: 3 }), 'E_INPUT_TOO_LARGE');
    rejects(() => readJsonFile(join(dir, 'missing.json')), 'E_INPUT_UNREADABLE');
    mkdirSync(join(dir, 'folder'));
    rejects(() => readJsonFile(join(dir, 'folder')), 'E_INPUT_UNREADABLE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unreadable-file errors do not reveal the path', () => {
  try {
    readJsonFile('/nonexistent-dir-for-test/SECRET-PATH-NAME.json');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(!e.message.includes('SECRET-PATH-NAME'));
  }
});
