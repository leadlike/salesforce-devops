// Resource limits. They bound memory and CPU so that an oversized or hostile input
// (for example one supplied by an untrusted pull request) cannot stall a pipeline.
// Exceeding a limit is UNVERIFIABLE, never a partial result.

export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024, // 64 MiB per input file
  maxIdentities: 10_000,          // approved baseline entries
  maxUsers: 250_000,              // snapshot users
  maxDepth: 8,                    // JSON nesting; the schemas need 4
});
