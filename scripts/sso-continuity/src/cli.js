#!/usr/bin/env node
'use strict';
const {reconcile, loadJson} = require('./reconcile');
const args = process.argv.slice(2);
if (args.length !== 2) { console.error('Usage: node src/cli.js <baseline.json> <snapshot.json>'); process.exit(3); }
try {
  const result = reconcile(loadJson(args[0]), loadJson(args[1]));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === 'PASS' ? 0 : 2);
} catch (_) {
  console.error('UNVERIFIABLE: invalid, unreadable, or inconsistent input. No changes made.');
  process.exit(3);
}
