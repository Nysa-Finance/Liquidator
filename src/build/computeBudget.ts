import { address, type Instruction } from '@solana/kit';

export const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');

/** SetComputeUnitLimit = discriminant 0x02, u32 LE */
export function computeUnitLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

/** SetComputeUnitPrice = discriminant 0x03, u64 LE (micro-lamports per CU) */
export function computeUnitPriceIx(microLamports: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}
