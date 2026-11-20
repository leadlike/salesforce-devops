// The only Salesforce queries this module can ever run.
//
// Queries are generated here from fixed templates. Nothing the caller supplies is
// interpolated except the correlation field, which is validated by the policy and
// checked again below. Every query is a plain SELECT with no clauses, quotes or
// parentheses, which also keeps it safe to pass through the Windows command line.
//
// Fields that hold secrets are never selected: for example AuthProvider.ConsumerKey
// and AuthProvider.ConsumerSecret are not in any query.

import { Unverifiable } from './errors.mjs';

const OBJECTS = ['User', 'Organization', 'SamlSsoConfig', 'AuthProvider'];
const FIELD_LIST = /^[A-Za-z][A-Za-z0-9_]*(, [A-Za-z][A-Za-z0-9_]*)*$/;
const KEY_FIELD = /^(EmployeeNumber|[A-Za-z][A-Za-z0-9_]{0,60}__c)$/;
const FORBIDDEN_FIELDS = new Set(['ConsumerKey', 'ConsumerSecret', 'Password', 'SecurityToken']);

/** Final gate: a query must be SELECT <fields> FROM <allowed object> and nothing else. */
export function assertReadOnlyQuery(soql) {
  const m = typeof soql === 'string' ? /^SELECT (.+) FROM ([A-Za-z]+)$/.exec(soql) : null;
  if (!m || !OBJECTS.includes(m[2]) || !FIELD_LIST.test(m[1])) {
    throw new Unverifiable('E_INTERNAL', 'query rejected by the read-only gate');
  }
  for (const field of m[1].split(', ')) {
    if (FORBIDDEN_FIELDS.has(field)) throw new Unverifiable('E_INTERNAL', 'query rejected by the read-only gate');
  }
  return soql;
}

export const organizationQuery = () => assertReadOnlyQuery('SELECT Id FROM Organization');

export function usersQuery(correlationField) {
  if (typeof correlationField !== 'string' || !KEY_FIELD.test(correlationField)) {
    throw new Unverifiable('E_POLICY', 'invalid correlation field');
  }
  return assertReadOnlyQuery(`SELECT ${correlationField}, IsActive, FederationIdentifier, UserType FROM User`);
}

export const samlConfigQuery = () => assertReadOnlyQuery('SELECT DeveloperName, MasterLabel, IdentityMapping, IdentityLocation, OptionsUserProvisioning, Issuer, LoginUrl FROM SamlSsoConfig');

export const authProviderQuery = () => assertReadOnlyQuery('SELECT DeveloperName, FriendlyName, ProviderType FROM AuthProvider');
