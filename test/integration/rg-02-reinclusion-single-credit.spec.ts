/**
 * RG-02 — reorg re-includes the deposit at a different height:
 * confirmations recompute from the NEW inclusion, credit fires once.
 *
 * Chain events driven: deposit; mine 2; invalidate the containing block;
 *   mine one EMPTY competing block, then a block re-including the
 *   resurrected tx (one height higher than before); mine to N on the new
 *   chain.
 * Invariant: after re-inclusion the tracker's inclusion height is the new
 *   one; credit fires exactly when the NEW chain gives N confirmations,
 *   exactly once across the whole reorg; the wallet's confirmation count
 *   agrees at the end.
 * Custody risk: double-credit during reorg reconciliation, or credit
 *   timed off a stale inclusion height.
 * Falsification lever: FALSIFY=RG-02 pins the expectation to the STALE
 *   pre-reorg inclusion height; the recomputation assertion goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { confirmationsOf, type TrackerEvent } from '../../src/core/confirmations.js';
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
const DEPOSIT_SATS = 8_888_888n;
const ADDRESS_INDEX = 21;

describe('RG-02: re-inclusion credits once from the new height', () => {
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

  it('recomputes from the new inclusion and credits exactly once', async () => {
    const watcher = await ChainWatcher.create(node, new Set([address]), N);
    const allEvents: TrackerEvent[] = [];

    const txid = await signing.sendToAddress(address, DEPOSIT_SATS, 25);
    allEvents.push(...(await watcher.poll()));
    await mineToWallet(node, signing, 2);
    allEvents.push(...(await watcher.poll()));

    const recordNow = () => {
      const record = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
      expect(record).toBeDefined();
      if (record === undefined) {
        throw new Error('deposit record missing');
      }
      return record;
    };

    const before = recordNow();
    expect(before.inclusion).not.toBeNull();
    if (before.inclusion === null) {
      return;
    }
    const oldHeight = before.inclusion.height;

    // Reorg: one empty block first, so the re-inclusion lands one height up.
    await node.invalidateBlock(before.inclusion.blockHash);
    await node.generateBlock(await signing.getNewAddress(), []);
    await mineToWallet(node, signing, 1); // re-includes the resurrected tx
    allEvents.push(...(await watcher.poll()));

    const newHeight = oldHeight + 1;
    // FALSIFY=RG-02: demand the stale height — red because the tracker
    // recomputed from the new chain.
    const expectedInclusionHeight = falsifyActive('RG-02') ? oldHeight : newHeight;
    const reincluded = recordNow();
    expect(reincluded.state).toBe('CONFIRMING');
    expect(reincluded.inclusion?.height).toBe(expectedInclusionHeight);
    expect(confirmationsOf(reincluded, watcher.state.tipHeight)).toBe(
      watcher.state.tipHeight - newHeight + 1,
    );

    // Mine until the NEW inclusion reaches N confirmations.
    await mineToWallet(node, signing, N - confirmationsOf(reincluded, watcher.state.tipHeight));
    allEvents.push(...(await watcher.poll()));

    const credited = recordNow();
    expect(credited.state).toBe('CREDITED');
    expect(credited.creditedAtHeight).toBe(newHeight + N - 1);
    expect(confirmationsOf(credited, watcher.state.tipHeight)).toBe(N);

    const creditEvents = allEvents.filter((e) => e.kind === 'credited');
    expect(creditEvents).toHaveLength(1);
    expect(creditEvents[0]?.atHeight).toBe(newHeight + N - 1);

    expect((await watch.getTransaction(txid)).confirmations).toBe(N);
  });
});
