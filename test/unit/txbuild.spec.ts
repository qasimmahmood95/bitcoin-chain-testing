/**
 * TX-01/TX-02 (unit) — exact value conservation and selection guards.
 *
 * Chain events driven: none (pure — fast-check UTXO sets).
 * Invariant: for every successful build, Σ inputs = payment + change + fee
 *   EXACTLY in bigint sats; only ≥N-conf, unreserved UTXOs are ever
 *   selected; sub-dust change folds to fee and is never emitted; identical
 *   params build identical transactions.
 * Custody risk: fee leak / value destruction; spending unsettled deposits;
 *   the custodian double-spending itself under load.
 * Falsification lever: FALSIFY=TX-01 drops one satoshi into the observed
 *   fee; the conservation property goes red.
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { outpointKey } from '../../src/core/confirmations.js';
import {
  BuildError,
  buildSpend,
  InsufficientSpendableFundsError,
  type BuildParams,
  type BuiltSpend,
  type SpendableUtxo,
} from '../../src/core/txbuild.js';
import { falsifyActive } from '../../src/testing/falsify.js';

const N = 6;
const DUST = 546n;

// FALSIFY=TX-01: the classic one-satoshi fee leak.
function build(params: BuildParams): BuiltSpend {
  const built = buildSpend(params);
  return falsifyActive('TX-01') ? { ...built, feeSats: built.feeSats + 1n } : built;
}

const utxoArb: fc.Arbitrary<SpendableUtxo> = fc
  .record({
    tx: fc.nat({ max: 1_000_000 }),
    vout: fc.nat({ max: 3 }),
    amount: fc.bigInt({ min: 1_000n, max: 1_000_000_000n }),
    confirmations: fc.nat({ max: 12 }),
  })
  .map(({ tx, vout, amount, confirmations }) => ({
    outpoint: { txid: `utxo-${String(tx)}`, vout },
    amountSats: amount,
    confirmations,
  }));

const paramsArb: fc.Arbitrary<BuildParams> = fc
  .record({
    utxos: fc.uniqueArray(utxoArb, {
      maxLength: 12,
      selector: (u) => outpointKey(u.outpoint),
    }),
    paySats: fc.bigInt({ min: DUST, max: 500_000_000n }),
    feeRate: fc.bigInt({ min: 1n, max: 100n }),
  })
  .map(({ utxos, paySats, feeRate }) => ({
    utxos,
    reserved: new Set<string>(),
    finalityDepth: N,
    payAddress: 'bcrt1qpay',
    paySats,
    changeAddress: 'bcrt1qchange',
    feeRateSatPerVb: feeRate,
    dustThresholdSats: DUST,
  }));

describe('buildSpend', () => {
  it('conserves value exactly and never emits dust (property)', () => {
    fc.assert(
      fc.property(paramsArb, (params) => {
        let built: BuiltSpend;
        try {
          built = build(params);
        } catch (error) {
          expect(
            error instanceof InsufficientSpendableFundsError || error instanceof BuildError,
          ).toBe(true);
          return;
        }
        const byKey = new Map(params.utxos.map((u) => [outpointKey(u.outpoint), u]));
        const inputSum = built.inputs.reduce(
          (sum, input) => sum + (byKey.get(outpointKey(input))?.amountSats ?? 0n),
          0n,
        );
        const outputSum = built.outputs.reduce((sum, output) => sum + output.sats, 0n);
        // The invariant: Σ inputs = Σ outputs + fee, to the satoshi.
        expect(inputSum).toBe(outputSum + built.feeSats);
        // Every selected input is ≥N-conf and unreserved.
        for (const input of built.inputs) {
          const source = byKey.get(outpointKey(input));
          expect(source).toBeDefined();
          expect(source?.confirmations ?? 0).toBeGreaterThanOrEqual(N);
        }
        // Dust is never emitted.
        for (const output of built.outputs) {
          expect(output.sats).toBeGreaterThanOrEqual(DUST);
        }
        // Fee is never below the declared rate for the estimated size.
        expect(built.feeSats).toBeGreaterThanOrEqual(
          BigInt(built.estimatedVsize) * params.feeRateSatPerVb,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('is deterministic: identical params, identical transaction', () => {
    fc.assert(
      fc.property(paramsArb, (params) => {
        let first: BuiltSpend | null = null;
        let second: BuiltSpend | null = null;
        try {
          first = build(params);
        } catch {
          /* both must throw identically */
        }
        try {
          second = build(params);
        } catch {
          /* both must throw identically */
        }
        expect(second).toEqual(first);
      }),
      { numRuns: 100 },
    );
  });

  it('never selects a reserved outpoint (TX-02)', () => {
    const utxos: SpendableUtxo[] = [
      { outpoint: { txid: 'a'.repeat(64), vout: 0 }, amountSats: 5_000_000n, confirmations: 8 },
      { outpoint: { txid: 'b'.repeat(64), vout: 0 }, amountSats: 5_000_000n, confirmations: 8 },
    ];
    const base: BuildParams = {
      utxos,
      reserved: new Set(),
      finalityDepth: N,
      payAddress: 'bcrt1qpay',
      paySats: 4_000_000n,
      changeAddress: 'bcrt1qchange',
      feeRateSatPerVb: 10n,
      dustThresholdSats: DUST,
    };
    const first = build(base);
    const second = build({ ...base, reserved: new Set(first.reservedKeys) });
    expect(second.inputs.map(outpointKey)).not.toEqual(first.inputs.map(outpointKey));
    expect(() =>
      build({
        ...base,
        reserved: new Set([...first.reservedKeys, ...second.reservedKeys]),
      }),
    ).toThrow(InsufficientSpendableFundsError);
  });

  it('an under-depth UTXO is not money yet, however large (TX-02)', () => {
    const utxos: SpendableUtxo[] = [
      {
        outpoint: { txid: 'c'.repeat(64), vout: 0 },
        amountSats: 100_000_000n,
        confirmations: N - 1,
      },
      { outpoint: { txid: 'd'.repeat(64), vout: 0 }, amountSats: 2_000_000n, confirmations: N },
    ];
    const built = build({
      utxos,
      reserved: new Set(),
      finalityDepth: N,
      payAddress: 'bcrt1qpay',
      paySats: 1_000_000n,
      changeAddress: 'bcrt1qchange',
      feeRateSatPerVb: 10n,
      dustThresholdSats: DUST,
    });
    expect(built.inputs).toEqual([{ txid: 'd'.repeat(64), vout: 0 }]);
  });

  it('rejects sub-dust payments and non-positive amounts loudly', () => {
    const params: BuildParams = {
      utxos: [],
      reserved: new Set(),
      finalityDepth: N,
      payAddress: 'bcrt1qpay',
      paySats: DUST - 1n,
      changeAddress: 'bcrt1qchange',
      feeRateSatPerVb: 10n,
      dustThresholdSats: DUST,
    };
    expect(() => build(params)).toThrow(BuildError);
    expect(() => build({ ...params, paySats: 0n })).toThrow(BuildError);
    expect(() => build({ ...params, paySats: 1_000_000n, feeRateSatPerVb: 0n })).toThrow(
      BuildError,
    );
  });
});
