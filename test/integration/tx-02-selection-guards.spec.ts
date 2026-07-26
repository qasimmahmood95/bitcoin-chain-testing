/**
 * TX-02 — only settled money is spendable, and never twice.
 *
 * Chain events driven: fund a watched address twice so one UTXO sits at N
 *   confirmations and a LARGER one at N−1; build; reserve; build again;
 *   mine 1 so the second UTXO settles; build a third time.
 * Invariant: the under-depth UTXO is never selected however large; a
 *   reserved outpoint is never selected twice (second build fails for
 *   insufficient spendable funds until the other UTXO settles); the node
 *   accepts the built spend.
 * Custody risk: spending unsettled deposits; the custodian double-spending
 *   ITSELF under concurrent withdrawal load.
 * Falsification lever: FALSIFY=TX-02 disables the reservation on the
 *   second build; the must-fail assertion goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { outpointKey } from '../../src/core/confirmations.js';
import { deriveAddress } from '../../src/core/derivation.js';
import {
  buildSpend,
  InsufficientSpendableFundsError,
  type BuildParams,
} from '../../src/core/txbuild.js';
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
const SETTLED_SATS = 2_000_000n;
const UNSETTLED_SATS = 5_000_000n; // larger on purpose: depth must beat size

describe('TX-02: depth and reservation guards', () => {
  const node = connectRegtest();
  let signing: BitcoindRpc;
  let watchedAddress: string;
  let changeAddress: string;

  beforeAll(async () => {
    signing = await openSigningWallet(node);
    await ensureSpendableFunds(node, signing, SETTLED_SATS + UNSETTLED_SATS + 20_000_000n);
    const account = await signingWalletAccount(signing);
    watchedAddress = deriveAddress(account, 'receive', 31);
    changeAddress = deriveAddress(account, 'change', 31);
  });

  it('selects only ≥N-conf UTXOs, and each at most once', async () => {
    const settledTxid = await signing.sendToAddress(watchedAddress, SETTLED_SATS, 25);
    await mineToWallet(node, signing, 1);
    const unsettledTxid = await signing.sendToAddress(watchedAddress, UNSETTLED_SATS, 25);
    await mineToWallet(node, signing, N - 1);
    // settled: N confs; unsettled: N−1 confs.

    const relevant = (u: { outpoint: { txid: string } }) =>
      u.outpoint.txid === settledTxid || u.outpoint.txid === unsettledTxid;
    const utxos = (await spendableUtxosAt(signing, [watchedAddress])).filter(relevant);
    expect(utxos).toHaveLength(2);

    const base: BuildParams = {
      utxos,
      reserved: new Set(),
      finalityDepth: N,
      payAddress: await signing.getNewAddress(),
      paySats: 1_000_000n,
      changeAddress,
      feeRateSatPerVb: 25n,
      dustThresholdSats: 546n,
    };

    // Depth beats size: only the smaller, settled UTXO is eligible.
    const first = buildSpend(base);
    expect(first.inputs.map((i) => i.txid)).toEqual([settledTxid]);
    const { accept } = await signAndTestAccept(node, signing, first);
    expect(accept?.allowed).toBe(true);

    // FALSIFY=TX-02: the reservation is dropped — the same outpoint gets
    // selected twice and the must-fail assertion goes red.
    const reserved = falsifyActive('TX-02') ? new Set<string>() : new Set(first.reservedKeys);
    expect(() => buildSpend({ ...base, reserved })).toThrow(InsufficientSpendableFundsError);

    // One more block settles the larger UTXO; the reservation still holds.
    await mineToWallet(node, signing, 1);
    const utxosLater = (await spendableUtxosAt(signing, [watchedAddress])).filter(relevant);
    const third = buildSpend({
      ...base,
      utxos: utxosLater,
      reserved: new Set(first.reservedKeys),
    });
    expect(third.inputs.map((i) => i.txid)).toEqual([unsettledTxid]);
    expect(third.inputs.map(outpointKey)).not.toContain(first.reservedKeys[0]);
  });
});
