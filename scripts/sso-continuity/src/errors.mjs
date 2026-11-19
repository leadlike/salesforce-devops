// Error type for every condition that prevents a trustworthy result.
//
// The `code` is a stable, non-sensitive identifier that is safe to print and to
// match in automation. Messages are fixed strings: they never contain input values,
// because inputs describe identities.

export const ERROR_CODES = Object.freeze([
  'E_USAGE',
  'E_INPUT_UNREADABLE',
  'E_INPUT_TOO_LARGE',
  'E_INPUT_TOO_DEEP',
  'E_INPUT_INVALID_JSON',
  'E_INPUT_DUPLICATE_KEY',
  'E_SCHEMA',
  'E_SCHEMA_VERSION',
  'E_LIMIT_RECORDS',
  'E_ORG_MISMATCH',
  'E_BASELINE_EMPTY',
  'E_SNAPSHOT_INCOMPLETE',
  'E_INTERNAL',
]);

export class Unverifiable extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Unverifiable';
    this.code = code;
  }
}
