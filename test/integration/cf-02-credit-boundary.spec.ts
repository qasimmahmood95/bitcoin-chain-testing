/**
 * CF-02 — the credit boundary asserted as a triplet at N−1 / N / N+1
 * against the live chain, with the wallet as second observer.
 *
 * Chain events driven: broadcast a deposit; mine to exactly N−1
 *   confirmations, assert; mine 1 more (N), assert; mine 1 more (N+1),
 *   assert. Finality depth N = 6.
 * Invariant: credited flips false→true exactly at N; exactly one credited
 *   event ever; tracker confirmations equal the wallet's at every step.
 * Custody risk: off-by-one premature credit — one confirmation early is
 *   one reorg away from loss.
 * Falsification lever: FALSIFY=CF-02 lowers the tracker's finality depth
 *   to N−1; the not-credited-at-N−1 assertion goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { confirmationsOf } from '../../src/core/confirmations.js';
import { deriveAddress } from '../../src/core/derivation.js';
import type { BitcoindRpc } from '../../src/rpc/bitcoind.js';
import { falsifyActive } from '../../src/testing/falsify.js';
import {
  connectRegtest,
  ensureSpendableFunds,
  mineToWallet,
  openSigningWallet,
} from '../../src/testing/node.js';
import { ChainWatcher } from '../../src/watcher/watcher.js';
import { watchOnlyFixture } from '../support/watch-setup.js';

const N = 6;
const DEPOSIT_SATS = 7_777_777n;
const ADDRESS_INDEX = 11;

describe('CF-02: credit boundary triplet', () => {
  const node = connectRegtest();
  let signing: BitcoindRpc;
  let watch: BitcoindRpc;
  let address: string;

  beforeAll(async () => {
    signing = await openSigningWallet(node);
    const fixture = await watchOnlyFixture(node);
    watch = fixture.watch;
    address = deriveAddress(fixture.account, 'receive', ADDRESS_INDEX);
    await ensureSpendableFunds(node, signing, DEPOSIT_SATS + 10_000_000n);
  });

  async function walletConfirmations(txid: string): Promise<number> {
    const utxos = (await watch.listUnspent(0, [address])).filter((u) => u.txid === txid);
    expect(utxos).toHaveLength(1);
    return utxos[0]?.confirmations ?? -1;
  }

  it('credits exactly at N, once, in agreement with the wallet', async () => {
    // FALSIFY=CF-02: one confirmation early.
    const finalityDepth = falsifyActive('CF-02') ? N - 1 : N;
    const watcher = await ChainWatcher.create(node, new Set([address]), finalityDepth);
    const txid = await signing.sendToAddress(address, DEPOSIT_SATS, 25);
    await watcher.poll();

    const recordNow = () => {
      const record = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
      expect(record).toBeDefined();
      if (record === undefined) {
        throw new Error('deposit record missing');
      }
      return record;
    };

    // N−1 confirmations: pending in both observers.
    await mineToWallet(node, signing, N - 1);
    const eventsAtNMinus1 = await watcher.poll();
    expect(eventsAtNMinus1).toEqual([]);
    expect(recordNow().state).toBe('CONFIRMING');
    expect(recordNow().creditedAtHeight).toBeNull();
    expect(confirmationsOf(recordNow(), watcher.state.tipHeight)).toBe(N - 1);
    expect(await walletConfirmations(txid)).toBe(N - 1);

    // N confirmations: credit fires, exactly once, at this height.
    await mineToWallet(node, signing, 1);
    const eventsAtN = await watcher.poll();
    const record = recordNow();
    expect(eventsAtN).toEqual([
      { kind: 'credited', outpoint: record.outpoint, atHeight: watcher.state.tipHeight },
    ]);
    expect(record.state).toBe('CREDITED');
    expect(record.creditedAtHeight).toBe(watcher.state.tipHeight);
    expect(confirmationsOf(record, watcher.state.tipHeight)).toBe(N);
    expect(await walletConfirmations(txid)).toBe(N);

    // N+1: still credited, no second credit event.
    await mineToWallet(node, signing, 1);
    const eventsPastN = await watcher.poll();
    expect(eventsPastN).toEqual([]);
    expect(recordNow().state).toBe('CREDITED');
    expect(recordNow().creditedAtHeight).toBe(record.creditedAtHeight);
    expect(confirmationsOf(recordNow(), watcher.state.tipHeight)).toBe(N + 1);
    expect(await walletConfirmations(txid)).toBe(N + 1);
  });
});
