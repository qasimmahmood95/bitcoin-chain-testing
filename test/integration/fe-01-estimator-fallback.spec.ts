/**
 * FE-01 — the fee policy survives the estimator that never answers.
 *
 * Chain events driven: fund a watched address; mine to N; ask the LIVE
 *   regtest estimator (which has no fee history by design — the M1 pin);
 *   run the fee policy on its real output; build and validate a spend.
 * Invariant: estimatesmartfee's failure maps to a TYPED unavailable
 *   result; the policy falls back to the configured floor (never throws);
 *   the builder still produces a transaction the node accepts.
 * Custody risk: withdrawal outage the moment the estimator degrades — a
 *   live-incident classic.
 * Falsification lever: FALSIFY=FE-01 makes the fixture's estimator
 *   mapping throw on unavailability instead of falling back; the spec
 *   goes red before a single satoshi moves.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { deriveAddress } from '../../src/core/derivation.js';
import { chooseFeeRate, type EstimatorResult } from '../../src/core/feepolicy.js';
import { buildSpend } from '../../src/core/txbuild.js';
import type { BitcoindRpc, SmartFeeEstimate } from '../../src/rpc/bitcoind.js';
import { falsifyActive } from '../../src/testing/falsify.js';
import {
  connectRegtest,
  ensureSpendableFunds,
  mineToWallet,
  openSigningWallet,
} from '../../src/testing/node.js';
import { signingWalletAccount } from '../support/signing-account.js';
import { signAndTestAccept, spendableUtxosAt } from '../support/tx-fixture.js';

const N = 6;
const FUND_SATS = 2_000_000n;

// The RPC-shape → policy-input mapping a real custodian would run.
// FALSIFY=FE-01: unavailability throws instead of becoming typed data.
function toEstimatorResult(estimate: SmartFeeEstimate): EstimatorResult {
  if (estimate.feeRateSatsPerKvB === undefined) {
    if (falsifyActive('FE-01')) {
      throw new Error('estimator unavailable'); // the outage a custodian must not have
    }
    return { kind: 'unavailable', errors: estimate.errors ?? [] };
  }
  return { kind: 'estimate', feeRateSatsPerKvB: estimate.feeRateSatsPerKvB };
}

describe('FE-01: estimator-unavailable fallback, live', () => {
  const node = connectRegtest();
  let signing: BitcoindRpc;
  let watchedAddress: string;
  let changeAddress: string;

  beforeAll(async () => {
    signing = await openSigningWallet(node);
    await ensureSpendableFunds(node, signing, FUND_SATS + 10_000_000n);
    const account = await signingWalletAccount(signing);
    watchedAddress = deriveAddress(account, 'receive', 33);
    changeAddress = deriveAddress(account, 'change', 33);
  });

  it('falls back to the floor and still produces an acceptable tx', async () => {
    const estimate = await node.estimateSmartFee(6);
    expect(estimate.feeRateSatsPerKvB).toBeUndefined(); // the M1 pin, still true

    const chosen = chooseFeeRate(
      { floorSatPerVb: 2n, ceilingSatPerVb: 200n },
      toEstimatorResult(estimate),
    );
    expect(chosen).toEqual({ satPerVb: 2n, source: 'floor-fallback' });

    const fundTxid = await signing.sendToAddress(watchedAddress, FUND_SATS, 25);
    await mineToWallet(node, signing, N);
    const utxos = (await spendableUtxosAt(signing, [watchedAddress])).filter(
      (u) => u.outpoint.txid === fundTxid,
    );
    const built = buildSpend({
      utxos,
      reserved: new Set(),
      finalityDepth: N,
      payAddress: await signing.getNewAddress('bech32'),
      paySats: 1_000_000n,
      changeAddress,
      feeRateSatPerVb: chosen.satPerVb,
      dustThresholdSats: 546n,
    });
    const { accept } = await signAndTestAccept(node, signing, built);
    expect(accept?.allowed).toBe(true);
    expect(accept?.feeSats).toBe(built.feeSats);
  });
});
