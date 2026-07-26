/**
 * CF-01 — a mempool deposit is pending in both observers; nothing credits
 * at zero confirmations.
 *
 * Chain events driven: broadcast a deposit to a watched address; mine
 *   NOTHING.
 * Invariant: the tracker holds the deposit as SEEN_MEMPOOL with
 *   credited=false and zero confirmations; the watch-only wallet shows the
 *   same UTXO at 0 confirmations; re-polling changes nothing.
 * Custody risk: 0-conf crediting — the classic double-spend acceptance
 *   fraud.
 * Falsification lever: FALSIFY=CF-01 counts mempool sightings as credited
 *   in the spec's credited-view; the credited=false assertion goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { confirmationsOf } from '../../src/core/confirmations.js';
import { deriveAddress } from '../../src/core/derivation.js';
import type { BitcoindRpc } from '../../src/rpc/bitcoind.js';
import { falsifyActive } from '../../src/testing/falsify.js';
import { connectRegtest, ensureSpendableFunds, openSigningWallet } from '../../src/testing/node.js';
import { ChainWatcher } from '../../src/watcher/watcher.js';
import { watchOnlyFixture } from '../support/watch-setup.js';

const DEPOSIT_SATS = 5_555_555n;
const ADDRESS_INDEX = 10;

describe('CF-01: mempool-only deposit stays pending', () => {
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

  it('is SEEN_MEMPOOL / credited=false in the tracker and 0-conf in the wallet', async () => {
    const watcher = await ChainWatcher.create(node, new Set([address]), 6);
    const txid = await signing.sendToAddress(address, DEPOSIT_SATS, 25);

    const events = await watcher.poll();
    expect(events).toEqual([]); // nothing credits, nothing alerts

    const record = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
    expect(record).toBeDefined();
    if (record === undefined) {
      return;
    }
    expect(record.state).toBe('SEEN_MEMPOOL');
    expect(record.inclusion).toBeNull();
    expect(record.amountSats).toBe(DEPOSIT_SATS);
    expect(confirmationsOf(record, watcher.state.tipHeight)).toBe(0);

    // FALSIFY=CF-01: a credited-view that counts mempool sightings as money.
    const credited = falsifyActive('CF-01')
      ? record.state !== 'CONFLICTED'
      : record.state === 'CREDITED';
    expect(credited).toBe(false);

    // Second observer: the watch-only wallet sees the same pending UTXO.
    const walletView = (await watch.listUnspent(0, [address])).filter((u) => u.txid === txid);
    expect(walletView).toHaveLength(1);
    expect(walletView[0]?.amountSats).toBe(record.amountSats);
    expect(walletView[0]?.confirmations).toBe(0);

    // Re-poll: no chain events happened, nothing may change.
    const again = await watcher.poll();
    expect(again).toEqual([]);
    const recordAgain = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
    expect(recordAgain).toEqual(record);
  });
});
