/**
 * Transaction construction (M5, TX-01…TX-03): deterministic input
 * selection over credited (≥N-conf) watched UTXOs with in-flight
 * reservation, change to a caller-derived internal address, exact value
 * conservation in bigint satoshis. Pure — signing is delegated to the
 * node-side wallet via PSBT; this library never sees a key.
 *
 * vsize is estimated for P2WPKH-only spends (the only script type this
 * builder emits): 68 vB per input, 31 vB per P2WPKH output, 11 vB
 * overhead — a deliberate, documented over-approximation whose achieved
 * feerate the TX-03 scenario pins within tolerance against the node.
 */

import { outpointKey, type Outpoint } from './confirmations.js';

export interface SpendableUtxo {
  readonly outpoint: Outpoint;
  readonly amountSats: bigint;
  readonly confirmations: number;
}

export interface BuildParams {
  readonly utxos: readonly SpendableUtxo[];
  /** Outpoint keys already committed to an in-flight spend (TX-02). */
  readonly reserved: ReadonlySet<string>;
  /** Only UTXOs at or beyond this depth are settled money (TX-02). */
  readonly finalityDepth: number;
  readonly payAddress: string;
  readonly paySats: bigint;
  /** Caller-derived next internal-chain address (M2 derivation). */
  readonly changeAddress: string;
  readonly feeRateSatPerVb: bigint;
  /** Change below this folds into the fee — never emitted (TX-03). */
  readonly dustThresholdSats: bigint;
}

export interface BuiltSpend {
  readonly inputs: readonly Outpoint[];
  /** Ordered: payment first, change last (absent when folded to fee). */
  readonly outputs: readonly { readonly address: string; readonly sats: bigint }[];
  readonly feeSats: bigint;
  readonly changeSats: bigint | null;
  readonly estimatedVsize: number;
  /** Keys the caller must add to its reservation set on broadcast intent. */
  readonly reservedKeys: readonly string[];
}

export class BuildError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'BuildError';
  }
}

export class InsufficientSpendableFundsError extends BuildError {
  constructor(requiredSats: bigint, spendableSats: bigint) {
    super(
      `need ${String(requiredSats)} sats but only ${String(spendableSats)} spendable (≥N-conf, unreserved)`,
    );
    this.name = 'InsufficientSpendableFundsError';
  }
}

const INPUT_VBYTES = 68n;
const OUTPUT_VBYTES = 31n;
const OVERHEAD_VBYTES = 11n;

function vbytes(inputCount: number, outputCount: number): bigint {
  return OVERHEAD_VBYTES + INPUT_VBYTES * BigInt(inputCount) + OUTPUT_VBYTES * BigInt(outputCount);
}

/**
 * Deterministic largest-first selection: sort by (amount desc, outpoint key
 * asc) and take until the payment plus fee is covered. Same inputs in, same
 * transaction out — always.
 */
export function buildSpend(params: BuildParams): BuiltSpend {
  if (params.paySats <= 0n) {
    throw new BuildError(`payment must be positive: ${String(params.paySats)}`);
  }
  if (params.paySats < params.dustThresholdSats) {
    throw new BuildError(
      `payment ${String(params.paySats)} below dust threshold ${String(params.dustThresholdSats)} — unrelayable`,
    );
  }
  if (params.feeRateSatPerVb < 1n) {
    throw new BuildError(`fee rate must be at least 1 sat/vB: ${String(params.feeRateSatPerVb)}`);
  }
  if (params.dustThresholdSats < 0n) {
    throw new BuildError(
      `dust threshold must be non-negative: ${String(params.dustThresholdSats)}`,
    );
  }
  if (!Number.isInteger(params.finalityDepth) || params.finalityDepth < 1) {
    throw new BuildError(
      `finality depth must be a positive integer: ${String(params.finalityDepth)}`,
    );
  }

  const spendable = params.utxos
    .filter(
      (utxo) =>
        utxo.confirmations >= params.finalityDepth &&
        !params.reserved.has(outpointKey(utxo.outpoint)),
    )
    .sort((a, b) => {
      if (a.amountSats !== b.amountSats) {
        return a.amountSats > b.amountSats ? -1 : 1;
      }
      const keyA = outpointKey(a.outpoint);
      const keyB = outpointKey(b.outpoint);
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });
  const spendableTotal = spendable.reduce((sum, utxo) => sum + utxo.amountSats, 0n);

  const selected: SpendableUtxo[] = [];
  let selectedSats = 0n;
  for (const utxo of spendable) {
    selected.push(utxo);
    selectedSats += utxo.amountSats;

    // Try to settle with change first, then with change folded to fee.
    const feeWithChange = vbytes(selected.length, 2) * params.feeRateSatPerVb;
    const changeSats = selectedSats - params.paySats - feeWithChange;
    if (changeSats >= params.dustThresholdSats) {
      return {
        inputs: selected.map((u) => u.outpoint),
        outputs: [
          { address: params.payAddress, sats: params.paySats },
          { address: params.changeAddress, sats: changeSats },
        ],
        feeSats: feeWithChange,
        changeSats,
        estimatedVsize: Number(vbytes(selected.length, 2)),
        reservedKeys: selected.map((u) => outpointKey(u.outpoint)),
      };
    }

    const feeNoChange = vbytes(selected.length, 1) * params.feeRateSatPerVb;
    const surplus = selectedSats - params.paySats - feeNoChange;
    if (surplus >= 0n) {
      // Sub-dust surplus folds into the fee — dust is never emitted (TX-03).
      return {
        inputs: selected.map((u) => u.outpoint),
        outputs: [{ address: params.payAddress, sats: params.paySats }],
        feeSats: feeNoChange + surplus,
        changeSats: null,
        estimatedVsize: Number(vbytes(selected.length, 1)),
        reservedKeys: selected.map((u) => outpointKey(u.outpoint)),
      };
    }
  }

  throw new InsufficientSpendableFundsError(params.paySats, spendableTotal);
}
