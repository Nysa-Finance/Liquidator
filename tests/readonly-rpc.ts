export { createReadOnlyRpc, WriteAttemptError } from '../src/readonly.js';

/** Endpoint used by the live tests. The public one works, but it is slow and rate-limited. */
export const LIVE_RPC = process.env.RPC ?? process.env.RPC_PRIMARY ?? 'https://api.mainnet-beta.solana.com';

/** Active market the read-only tests run against. */
export const LIVE_MARKET = process.env.LIVE_MARKET ?? '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
