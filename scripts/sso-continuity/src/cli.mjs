#!/usr/bin/env node
// Command-line entry point for the read-only Federation ID reconciliation.
//
//   node src/cli.mjs <baseline.json> <snapshot.json>
//
// Exit codes: 0 = every baseline identity matches and no unmanaged user exists,
//             2 = findings require review,
//             3 = the input is invalid or unverifiable, or an internal error occurred.
//
// Only `0` means success. Pipelines must not treat 2 or 3 as success.

import { pathToFileURL } from 'node:url';
import { reconcile } from './reconcile.mjs';
import { readJsonFile } from './json-input.mjs';
import { Unverifiable } from './errors.mjs';

export const EXIT = Object.freeze({ PASS: 0, REVIEW_REQUIRED: 2, UNVERIFIABLE: 3 });

export function main(argv, { read = readJsonFile, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  try {
    if (argv.length !== 2) throw new Unverifiable('E_USAGE', 'usage: node src/cli.mjs <baseline.json> <snapshot.json>');
    const result = reconcile(read(argv[0]), read(argv[1]));
    out(`${JSON.stringify(result, null, 2)}\n`);
    return result.verdict === 'PASS' ? EXIT.PASS : EXIT.REVIEW_REQUIRED;
  } catch (error) {
    // Messages of unexpected errors are never printed: they can contain input data.
    const known = error instanceof Unverifiable;
    const code = known ? error.code : 'E_INTERNAL';
    const message = known ? error.message : 'unexpected internal error';
    err(`UNVERIFIABLE [${code}]: ${message}. No changes were made.\n`);
    return EXIT.UNVERIFIABLE;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // process.exitCode, not process.exit(): exit() can cut off output that is still
  // being written to a pipe.
  process.exitCode = main(process.argv.slice(2));
}
