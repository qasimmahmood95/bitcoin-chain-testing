/**
 * RG-06 — a credited deposit first seen ON-CHAIN, reorged out and
 * re-sighted in the mempool, is never credited twice.
 *
 * Chain events driven: deposit broadcast and mined WITHOUT an intervening
 *   poll (so the watcher's first sighting of it is a block, never the
 *   mempool — the ordinary case when a deposit lands between two polls);
 *   mine to N so it credits; invalidate its block so the transaction
 *   re-enters the mempool; mine a 4-block competing chain; poll (the
 *   mempool scan now sees this txid for the FIRST time, on a record that
 *   already exists); re-mine the deposit and mature it past N again.
 * Invariant: the mempool re-sighting never downgrades the existing
 *   record — credit stays latched at its original height, the disconnect
 *   raises FINALITY_VIOLATION, and across the entire run exactly ONE
 *   credit event is emitted even though the deposit confirms to depth N
 *   twice.
 * Custody risk: double-credit via resurrection — the same deposit paid
 *   out twice because a second sighting looked like a new one. This is
 *   the live-shaped version of the `defect/rebroadcast-double-credit`
 *   bug, which the unit suite caught but no integration scenario did
 *   until this one.
 * Falsification lever: FALSIFY=RG-06 continues the run through a fresh
 *   watcher with no checkpoint, applied AFTER the post-reorg assertions so
 *   the sabotage lands on the exactly-once pin itself: the credit latch is
 *   lost, the re-mine credits the same deposit a second time, and the
 *   single-credit assertion goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { TrackerEvent } from '../../src/core/confirmations.js';
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
const DEPOSIT_SATS = 6_161_616n;
const ADDRESS_INDEX = 25;

describe('RG-06: resurrected deposit re-sighted in the mempool', () => {
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

  it('credits exactly once despite confirming to depth N twice', async () => {
    let watcher = await ChainWatcher.create(node, new Set([address]), N);
    const allEvents: TrackerEvent[] = [];

    // No poll between broadcast and mining: the watcher's first sighting
    // of this deposit is a CONNECT, so its txid never enters the
    // mempool-seen set.
    const txid = await signing.sendToAddress(address, DEPOSIT_SATS, 25);
    await mineToWallet(node, signing, N);
    allEvents.push(...(await watcher.poll()));

    const credited = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
    expect(credited?.state).toBe('CREDITED');
    expect(credited?.creditedAtHeight).not.toBeNull();
    expect(allEvents.filter((e) => e.kind === 'credited')).toHaveLength(1);
    const creditHeight = credited?.creditedAtHeight;
    const inclusionHash = credited?.inclusion?.blockHash;
    expect(inclusionHash).toBeDefined();
    if (inclusionHash === undefined) {
      return;
    }

    // Reorg the deposit out: it re-enters the mempool, still valid.
    await node.invalidateBlock(inclusionHash);
    expect(await node.getRawMempool()).toContain(txid);
    const minerAddress = await signing.getNewAddress();
    for (let i = 0; i < 4; i += 1) {
      await node.generateBlock(minerAddress, []);
    }

    // This poll scans the mempool FIRST and meets this txid there for the
    // first time, on a record that already exists and is already credited.
    allEvents.push(...(await watcher.poll()));

    const afterReorg = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
    expect(afterReorg?.state).toBe('CREDITED'); // sticky: alert, never clawback
    expect(afterReorg?.creditedAtHeight).toBe(creditHeight);
    expect(
      allEvents.filter((e) => e.kind === 'finality-violation' && e.outpoint.txid === txid),
    ).toHaveLength(1);

    // FALSIFY=RG-06: the run continues through a watcher that lost its
    // state — the credit latch goes with it, so the re-mine below credits
    // the SAME deposit a second time. Placed here on purpose: sabotaging
    // before the assertions above would abort the spec there and leave the
    // exactly-once pin (the point of this scenario) unexercised.
    if (falsifyActive('RG-06')) {
      watcher = await ChainWatcher.create(node, new Set([address]), N);
    }

    // Re-mine the deposit and take it past N a SECOND time.
    await mineToWallet(node, signing, N + 1);
    allEvents.push(...(await watcher.poll()));

    const final = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
    expect(final?.state).toBe('CREDITED');
    expect(final?.creditedAtHeight).toBe(creditHeight);
    // The whole point: confirmed to depth N twice, credited exactly once.
    expect(allEvents.filter((e) => e.kind === 'credited')).toHaveLength(1);

    // Wallet oracle agrees the deposit is confirmed again on the new chain.
    expect((await watch.getTransaction(txid)).confirmations).toBeGreaterThanOrEqual(N);
  });
});
