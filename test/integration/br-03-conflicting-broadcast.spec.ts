/**
 * BR-03 — broadcasting a spend whose input is already taken fails
 * TYPED and TERMINAL, against both a mempool and a chain conflict.
 *
 * Chain events driven: fund a watched address; mine to N; sign TWO
 *   competing spends of the same UTXO (A at 25 sat/vB, B underpaying at
 *   10); broadcast A; attempt B (mempool conflict); mine 1 so A confirms;
 *   attempt B again (chain conflict).
 * Invariant: the mempool conflict refuses with RPC -26 "insufficient fee,
 *   rejecting replacement …" (unconditional full-RBF — the M4 pin, now at
 *   the sendrawtransaction surface) and the chain conflict with RPC -25
 *   "bad-txns-inputs-missingorspent" [pin: M6]; both classify to a typed
 *   rejection; B's record reaches terminal failed on the FIRST rejection
 *   and is byte-identical after the second; A's accounting is untouched —
 *   the UTXO is spent exactly once, by A.
 * Custody risk: withdrawals stuck "in-flight forever" while support pages
 *   the on-call; partial debits from a rejection nobody surfaced.
 * Falsification lever: FALSIFY=BR-03 swallows the rejection — the record
 *   never leaves in-flight and the terminal-failed pin goes red.
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

describe('BR-03: conflicting-input broadcast is typed and terminal', () => {
  const node = connectRegtest();
  let signing: BitcoindRpc;
  let watchedAddress: string;
  let changeAddress: string;

  beforeAll(async () => {
    signing = await openSigningWallet(node);
    await ensureSpendableFunds(node, signing, FUND_SATS + 10_000_000n);
    const account = await signingWalletAccount(signing);
    watchedAddress = deriveAddress(account, 'receive', 42);
    changeAddress = deriveAddress(account, 'change', 42);
  });

  it('mempool then chain conflict: -26, -25, one terminal failure', async () => {
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

    // Sign both competitors while the coin is still unspent in the UTXO
    // set (the RG-03 lesson: the wallet cannot sign a spend of a coin the
    // chain already shows as spent).
    const base = {
      utxos,
      reserved: new Set<string>(),
      finalityDepth: N,
      paySats: 1_000_000n,
      changeAddress,
      dustThresholdSats: 546n,
    };
    const builtA = buildSpend({
      ...base,
      payAddress: await signing.getNewAddress('bech32'),
      feeRateSatPerVb: 25n,
    });
    const builtB = buildSpend({
      ...base,
      payAddress: await signing.getNewAddress('bech32'),
      feeRateSatPerVb: 10n, // underpays A — never a valid replacement
    });
    const signedA = await signAndTestAccept(node, signing, builtA);
    expect(signedA.accept?.allowed).toBe(true);
    const signedB = await signAndTestAccept(node, signing, builtB);
    // B is a VALID tx (accepted standalone) refused later only for the conflict.
    expect(signedB.accept?.allowed).toBe(true);
    const txidB = signedB.accept?.txid ?? '';
    expect(txidB).not.toBe('');

    const sentA = await attemptBroadcast(node, signedA.hex);
    expect(sentA.kind).toBe('sent');

    let record: WithdrawalRecord = initialWithdrawal(txidB);
    const applyAttempt = (attempt: Awaited<ReturnType<typeof attemptBroadcast>>): void => {
      const outcome = classifyBroadcastResult(attempt, txidB);
      // FALSIFY=BR-03: the rejection is swallowed — nothing reaches the ledger.
      if (falsifyActive('BR-03') && outcome.kind === 'rejected-conflict') {
        return;
      }
      record = applyBroadcastOutcome(record, outcome);
    };

    // Mempool conflict: A occupies the input; underpaying B loses the
    // replacement race. [pin: M6, the M4 full-RBF pin at this surface]
    const mempoolConflict = await attemptBroadcast(node, signedB.hex);
    expect(mempoolConflict.kind).toBe('rpc-error');
    if (mempoolConflict.kind === 'rpc-error') {
      expect(mempoolConflict.code).toBe(-26);
      expect(mempoolConflict.message).toContain('insufficient fee, rejecting replacement');
    }
    applyAttempt(mempoolConflict);
    expect(record.state).toBe('failed');
    const afterFirstRejection = JSON.stringify(record);

    // Chain conflict: A confirms; B's input is now spent on-chain. [pin: M6]
    const [minedHash] = await mineToWallet(node, signing, 1);
    const chainConflict = await attemptBroadcast(node, signedB.hex);
    expect(chainConflict).toEqual({
      kind: 'rpc-error',
      code: -25,
      message: 'bad-txns-inputs-missingorspent',
    });
    applyAttempt(chainConflict);
    expect(record.state).toBe('failed');
    expect(JSON.stringify(record)).toBe(afterFirstRejection);

    // Accounting intact: the funding outpoint was spent exactly once, by A.
    const block = await node.getBlockWithTransactions(minedHash ?? '');
    const spenders = block.transactions.filter((tx) =>
      tx.inputs.some(
        (input) => input.txid === funding.outpoint.txid && input.vout === funding.outpoint.vout,
      ),
    );
    expect(spenders.map((tx) => tx.txid)).toEqual([signedA.accept?.txid]);
    expect(await node.getRawMempool()).not.toContain(txidB);
  });
});
