/**
 * BR-01 — rebroadcast of an unconfirmed withdrawal is free, ×k.
 *
 * Chain events driven: fund a watched address; mine to N; build, sign,
 *   broadcast; rebroadcast the IDENTICAL hex three more times while
 *   unconfirmed; mine 1.
 * Invariant: every retry returns the same txid with no error [pin: M6 —
 *   already-in-mempool is success, not an error]; the tx stays present
 *   and the mempool size never moves across retries (no second entry is
 *   ever minted); the withdrawal record is byte-identical after every
 *   retry; the mined block spends the funding outpoint exactly once.
 * Custody risk: retry-storm double-debit — rebroadcast is routine ops and
 *   must never mint a second ledger entry or a second spend.
 * Falsification lever: FALSIFY=BR-01 records per broadcast attempt — the
 *   byte-identical assertion goes red on the first retry.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyBroadcastOutcome,
  classifyBroadcastResult,
  initialWithdrawal,
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
const RETRIES = 3;

describe('BR-01: rebroadcast idempotency while unconfirmed', () => {
  const node = connectRegtest();
  let signing: BitcoindRpc;
  let watchedAddress: string;
  let changeAddress: string;

  beforeAll(async () => {
    signing = await openSigningWallet(node);
    await ensureSpendableFunds(node, signing, FUND_SATS + 10_000_000n);
    const account = await signingWalletAccount(signing);
    watchedAddress = deriveAddress(account, 'receive', 40);
    changeAddress = deriveAddress(account, 'change', 40);
  });

  it('same txid, one mempool entry, one ledger record, one spend', async () => {
    const fundTxid = await signing.sendToAddress(watchedAddress, FUND_SATS, 25);
    await mineToWallet(node, signing, N);
    const utxos = (await spendableUtxosAt(signing, [watchedAddress])).filter(
      (u) => u.outpoint.txid === fundTxid,
    );
    expect(utxos).toHaveLength(1);
    const [funding] = utxos;
    if (funding === undefined) {
      throw new Error('unreachable: asserted exactly one funding UTXO');
    }

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

    // First broadcast: accepted, in-flight.
    const first = await attemptBroadcast(node, hex);
    let record: WithdrawalRecord = applyBroadcastOutcome(
      initialWithdrawal(spendTxid),
      classifyBroadcastResult(first, spendTxid),
    );
    const baseline = JSON.stringify(record);
    const mempoolAfterFirst = await node.getRawMempool();
    expect(mempoolAfterFirst).toContain(spendTxid);

    // Retry volley: the node-side pin and the accounting invariant, per attempt.
    for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
      const retry = await attemptBroadcast(node, hex);
      // [pin: M6] already-in-mempool is SUCCESS returning the same txid.
      expect(retry).toEqual({ kind: 'sent', txid: spendTxid });

      record = applyBroadcastOutcome(record, classifyBroadcastResult(retry, spendTxid));
      // FALSIFY=BR-01: a per-attempt annotation slips into the record.
      if (falsifyActive('BR-01')) {
        record = { ...record, failureReason: `attempt ${String(attempt)}` };
      }
      expect(JSON.stringify(record)).toBe(baseline);

      // Still present, and the size never moves: a retry that minted a
      // SECOND entry (different txid) would break the equality.
      const mempool = await node.getRawMempool();
      expect(mempool).toContain(spendTxid);
      expect(mempool.length).toBe(mempoolAfterFirst.length);
    }

    // The funding outpoint is spent exactly once in the mined block.
    const [minedHash] = await mineToWallet(node, signing, 1);
    expect(minedHash).toBeDefined();
    const block = await node.getBlockWithTransactions(minedHash ?? '');
    const spenders = block.transactions.filter((tx) =>
      tx.inputs.some(
        (input) => input.txid === funding.outpoint.txid && input.vout === funding.outpoint.vout,
      ),
    );
    expect(spenders.map((tx) => tx.txid)).toEqual([spendTxid]);
  });
});
