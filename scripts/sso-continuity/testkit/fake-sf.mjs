// A fake Salesforce CLI runner for offline tests. It answers `sf data query` from
// fictional fixtures and records every call so tests can prove what was (not) run.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const fixturePath = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
export const fixtureJson = (name) => JSON.parse(readFileSync(fixturePath(name), 'utf8'));

/** Build a successful `sf data query --json` response. */
export const queryResponse = (records, extra = {}) => ({ status: 0, result: { records, totalSize: records.length, done: true, ...extra } });

const OBJECT_OF = (soql) => /FROM ([A-Za-z]+)$/.exec(soql)?.[1];

/**
 * Create a runner. `responses` maps an object name (User, Organization, SamlSsoConfig,
 * AuthProvider) to either a response document or a function returning a runner result.
 * Returns the runner with a `calls` array of the argument vectors it received.
 */
export function fakeSf(responses) {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    const soql = args[args.indexOf('--query') + 1];
    const response = responses[OBJECT_OF(soql)];
    if (response === undefined) return { status: 1, stdout: '', timedOut: false };
    if (typeof response === 'function') return response(args);
    return { status: 0, stdout: JSON.stringify(response), timedOut: false };
  };
  runner.calls = calls;
  return runner;
}

/** Responses built from the shipped fictional fixtures. */
export const fixtureResponses = () => ({
  Organization: fixtureJson('sf/organization.json'),
  User: fixtureJson('sf/users.json'),
  SamlSsoConfig: fixtureJson('sf/saml.json'),
  AuthProvider: fixtureJson('sf/authproviders.json'),
});
