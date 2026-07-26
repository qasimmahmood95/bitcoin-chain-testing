/**
 * BR-02 — rebroadcast after the withdrawal is mined is a terminal
 * success, at 1 conf and at N.
 *
 * Chain events driven: fund a watched address; mine to N; build, sign,
 *   broadcast; mine 1 (spend confirms); rebroadcast the identical hex;
 *   mine to N confs; rebroadcast again.
 * Invariant: the node refuses with RPC -27 "Transaction outputs already
 *   in utxo set" at both depths [pin: M6]; the classifier maps it to a
 *   typed already-mined success; the withdrawal record is byte-identical
 *   after each retry — no error-path corruption, no duplicate record, and
 *   the tx never re-enters the mempool.
 * Custody risk: crash-looping settlement workers turning retry-after-
 *   confirm into duplicate settlement or a spurious failure.
 * Falsification lever: FALSIFY=BR-02 treats the node error as a fresh
 *   failure — the record flips to failed and the state pin goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyBroadcastOutcome,
  classifyBroadcastResult,
  initialWithdrawal,
  type BroadcastOutcome,
  type WithdrawalRecord,
} from '../../src/core/broadcast.js';
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
import { attemptBroadcast } from '../support/br-fixture.js';
import { signingWalletAccount } from '../support/signing-account.js';
import { signAndTestAccept, spendableUtxosAt } from '../support/tx-fixture.js';

const N = 6;
const FUND_SATS = 3_000_000n;

describe('BR-02: rebroadcast after mining is terminal success', () => {
  const node = connectRegtest();
  let signing: BitcoindRpc;
  let watchedAddress: string;
  let changeAddress: string;

  beforeAll(async () => {
    signing = await openSigningWallet(node);
    await ensureSpendableFunds(node, signing, FUND_SATS + 10_000_000n);
    const account = await signingWalletAccount(signing);
    watchedAddress = deriveAddress(account, 'receive', 41);
    changeAddress = deriveAddress(account, 'change', 41);
  });

  it('RPC -27 at 1 conf and at N, record untouched both times', async () => {
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
      feeRateSatPerVb: 25n,
      dustThresholdSats: 546n,
    });
    const { hex, accept } = await signAndTestAccept(node, signing, built);
    expect(accept?.allowed).toBe(true);
    const spendTxid = accept?.txid ?? '';

    let record: WithdrawalRecord = applyBroadcastOutcome(
      initialWithdrawal(spendTxid),
      classifyBroadcastResult(await attemptBroadcast(node, hex), spendTxid),
    );
    const baseline = JSON.stringify(record);

    const retryMined = async (confs: number): Promise<void> => {
      const retry = await attemptBroadcast(node, hex);
      // [pin: M6] the exact refusal Core 31.1 emits for a mined tx.
      expect(retry).toEqual({
        kind: 'rpc-error',
        code: -27,
        message: 'Transaction outputs already in utxo set',
      });

      // FALSIFY=BR-02: the node error is treated as a fresh failure.
      const outcome: BroadcastOutcome = falsifyActive('BR-02')
        ? { kind: 'rejected-conflict', reason: 'Transaction outputs already in utxo set' }
        : classifyBroadcastResult(retry, spendTxid);
      record = applyBroadcastOutcome(record, outcome);
      expect(record.state).toBe('in-flight');
      expect(JSON.stringify(record)).toBe(baseline);

      expect(await node.getRawMempool()).not.toContain(spendTxid);
      expect((await signing.getTransaction(spendTxid)).confirmations).toBe(confs);
    };

    await mineToWallet(node, signing, 1);
    await retryMined(1);
    await mineToWallet(node, signing, N - 1);
    await retryMined(N);
  });
});
