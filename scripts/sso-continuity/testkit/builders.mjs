// Test helpers. Kept outside test/ because `node --test` executes every file in test/.
// All data is fictional.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

export const baseline = (identities, orgKey = 'fictional-qa') => ({ schemaVersion: 1, orgKey, identities });
export const snapshot = (users, orgKey = 'fictional-qa', extra = {}) => ({ schemaVersion: 1, orgKey, users, ...extra });
export const id = (userKey, federationId) => ({ userKey, federationId });
export const user = (userKey, federationId, active = true) => ({ userKey, active, federationId });

/** Write documents (objects are serialized, strings are written verbatim) and run the real CLI. */
export function runCli(docs, { rawArgs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sso-continuity-'));
  try {
    const paths = docs.map((doc, index) => {
      const path = join(dir, `input-${index}.json`);
      writeFileSync(path, typeof doc === 'string' || Buffer.isBuffer(doc) ? doc : JSON.stringify(doc));
      return path;
    });
    const args = rawArgs ?? paths;
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, env: { PATH: process.env.PATH } });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, dir, paths };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
