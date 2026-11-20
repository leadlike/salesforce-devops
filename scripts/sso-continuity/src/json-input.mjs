// Strict JSON loading.
//
// JSON.parse accepts several things that are dangerous for a security baseline:
// a duplicate object key silently overrides the earlier one (so a reviewer can see
// one value while the program uses another), and its error messages can contain
// fragments of the input. This module closes those gaps and enforces size and
// nesting limits before the document is parsed.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Unverifiable } from './errors.mjs';
import { DEFAULT_LIMITS } from './limits.mjs';

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN = [0x7b, 0x5b];  // { [
const CLOSE = [0x7d, 0x5d]; // } ]

/** Reject excessive nesting. Tolerates invalid JSON; it only tracks brackets outside strings. */
function assertDepth(text, maxDepth) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === BACKSLASH) escaped = true;
      else if (c === QUOTE) inString = false;
      continue;
    }
    if (c === QUOTE) inString = true;
    else if (OPEN.includes(c)) {
      depth += 1;
      if (depth > maxDepth) throw new Unverifiable('E_INPUT_TOO_DEEP', 'input is nested too deeply');
    } else if (CLOSE.includes(c)) depth -= 1;
  }
}

/** Reject objects that repeat a key. The text must already be valid JSON. */
function assertNoDuplicateKeys(text) {
  const stack = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.keys && top.expectKey) {
        const raw = text.slice(i, j + 1);
        // Decode escapes so that "a" and "a" are recognized as the same key.
        const key = raw.includes('\\') ? JSON.parse(raw) : raw.slice(1, -1);
        if (top.keys.has(key)) throw new Unverifiable('E_INPUT_DUPLICATE_KEY', 'input contains a duplicate object key');
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (ch === '[') stack.push({ keys: null, expectKey: false });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top && top.keys) top.expectKey = true;
    }
    i += 1;
  }
}

/** Parse JSON text strictly. Accepts one leading UTF-8 byte order mark (common on Windows). */
export function parseJsonText(text, limits = DEFAULT_LIMITS) {
  if (typeof text !== 'string') throw new Unverifiable('E_INPUT_INVALID_JSON', 'input is not valid JSON');
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  assertDepth(body, limits.maxDepth);
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    // The parser's own message is deliberately dropped: it can quote the input.
    throw new Unverifiable('E_INPUT_INVALID_JSON', 'input is not valid JSON');
  }
  assertNoDuplicateKeys(body);
  return value;
}

function readText(path, limits) {
  try {
    const info = statSync(path);
    if (!info.isFile()) throw new Unverifiable('E_INPUT_UNREADABLE', 'input is unreadable');
    if (info.size > limits.maxFileBytes) throw new Unverifiable('E_INPUT_TOO_LARGE', 'input exceeds the size limit');
    return readFileSync(path);
  } catch (e) {
    if (e instanceof Unverifiable) throw e;
    throw new Unverifiable('E_INPUT_UNREADABLE', 'input is unreadable');
  }
}

/** Read and parse a JSON file with a size limit. Only regular files are accepted. */
export function readJsonFile(path, limits = DEFAULT_LIMITS) {
  return parseJsonText(readText(path, limits).toString('utf8'), limits);
}

/** Like readJsonFile, and also returns the SHA-256 of the exact file bytes (for pinning). */
export function readJsonFileWithDigest(path, limits = DEFAULT_LIMITS) {
  const bytes = readText(path, limits);
  return { value: parseJsonText(bytes.toString('utf8'), limits), sha256: createHash('sha256').update(bytes).digest('hex') };
}
