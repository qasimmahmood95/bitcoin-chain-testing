/**
 * TX-03 — dust folds into the fee, and the achieved feerate stays inside
 * a declared tolerance of the target.
 *
 * Chain events driven: fund a watched address with an exact amount; build
 *   a spend whose change would be sub-dust; PSBT hand-off; validate via
 *   testmempoolaccept.
 * Invariant: no output below the dust threshold is ever emitted (the
 *   sub-dust surplus folds into the fee); the node accepts; the achieved
 *   feerate (node fee / node vsize) is ≥ the target and ≤ 2× the target.
 * Custody risk: unrelayable withdrawals wedging the queue; systematic fee
 *   overpay.
 * Falsification lever: FALSIFY=TX-03 zeroes the builder's dust threshold —
 *   the sub-dust change is emitted as a real output and the no-dust
 *   assertion goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { deriveAddress } from '../../src/core/derivation.js';
import { buildSpend } from '../../src/core/txbuild.js';
import type { BitcoindRpc } from '../../src/rpc/bitcoind.js';
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
const DUST = 546n;
const FUND_SATS = 1_000_000n;
const FEE_RATE = 10n;
// One input, one output: 11 + 68 + 31 = 110 vB → 1_100 sats at the target.
// Pay so the remainder (1_400) exceeds the pay-only fee by a sub-dust 300.
const PAY_SATS = FUND_SATS - 1_400n;

describe('TX-03: dust folding and feerate tolerance', () => {
  const node = connectRegtest();
  let signing: BitcoindRpc;
  let watchedAddress: string;
  let changeAddress: string;

  beforeAll(async () => {
    signing = await openSigningWallet(node);
    await ensureSpendableFunds(node, signing, FUND_SATS + 10_000_000n);
    const account = await signingWalletAccount(signing);
    watchedAddress = deriveAddress(account, 'receive', 32);
    changeAddress = deriveAddress(account, 'change', 32);
  });

  it('folds sub-dust change into the fee within tolerance', async () => {
    const fundTxid = await signing.sendToAddress(watchedAddress, FUND_SATS, 25);
    await mineToWallet(node, signing, N);
    const utxos = (await spendableUtxosAt(signing, [watchedAddress])).filter(
      (u) => u.outpoint.txid === fundTxid,
    );
    expect(utxos).toHaveLength(1);

    // FALSIFY=TX-03: dust threshold zeroed — the 300-sat change is emitted.
    const dustThresholdSats = falsifyActive('TX-03') ? 0n : DUST;
    const built = buildSpend({
      utxos,
      reserved: new Set(),
      finalityDepth: N,
      payAddress: await signing.getNewAddress(),
      paySats: PAY_SATS,
      changeAddress,
      feeRateSatPerVb: FEE_RATE,
      dustThresholdSats,
    });

    // Dust is never emitted; the surplus lives in the fee instead.
    for (const output of built.outputs) {
      expect(output.sats).toBeGreaterThanOrEqual(DUST);
    }
    expect(built.outputs).toHaveLength(1);
    expect(built.changeSats).toBeNull();
    expect(built.feeSats).toBe(1_400n);

    const { accept } = await signAndTestAccept(node, signing, built);
    expect(accept?.allowed).toBe(true);
    expect(accept?.feeSats).toBe(built.feeSats);
    const vsize = accept?.vsize;
    expect(vsize).toBeDefined();
    if (vsize === undefined || accept?.feeSats === undefined) {
      return;
    }
    // Achieved feerate within [target, 2×target].
    expect(accept.feeSats).toBeGreaterThanOrEqual(FEE_RATE * BigInt(vsize));
    expect(accept.feeSats).toBeLessThanOrEqual(2n * FEE_RATE * BigInt(vsize));
  });
});
