export { createReadOnlyRpc, WriteAttemptError } from '../src/readonly.js';

/** Endpoint usato dai test live. Il pubblico basta, ma è lento e a rate limit. */
export const LIVE_RPC = process.env.RPC ?? process.env.RPC_PRIMARY ?? 'https://api.mainnet-beta.solana.com';

/** Market attivo su cui girano i test di sola lettura. */
export const LIVE_MARKET = process.env.LIVE_MARKET ?? '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
