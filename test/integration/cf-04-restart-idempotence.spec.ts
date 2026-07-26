/**
 * CF-04 — restart from checkpoint: exactly one credit per deposit, ever;
 * replay changes nothing.
 *
 * Chain events driven: deposit; mine to N; poll (credit fires); checkpoint
 *   the watcher; restart a second watcher from the checkpoint; re-poll the
 *   same window.
 * Invariant: the restarted watcher emits nothing and reaches a state
 *   identical to the original; total credited events for the outpoint
 *   across all watcher instances is exactly one; the wallet agrees
 *   throughout.
 * Custody risk: double-credit on rescan/restart — free money printed by an
 *   ops routine.
 * Falsification lever: FALSIFY=CF-04 drops the checkpoint and restarts
 *   from the pre-deposit start instead, forcing a full re-walk — the
 *   exactly-one-credit assertion goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { snapshotTrackerState } from '../../src/core/confirmations.js';
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
const DEPOSIT_SATS = 9_999_999n;
const ADDRESS_INDEX = 12;

describe('CF-04: restart and replay idempotence', () => {
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

  it('credits exactly once across restart; replay is a no-op', async () => {
    const watched = new Set([address]);
    const watcherA = await ChainWatcher.create(node, watched, N);
    const startCheckpoint = watcherA.checkpoint(); // pre-deposit world

    const txid = await signing.sendToAddress(address, DEPOSIT_SATS, 25);
    await watcherA.poll();
    await mineToWallet(node, signing, N);
    const creditEvents = (await watcherA.poll()).filter((e) => e.kind === 'credited');
    expect(creditEvents).toHaveLength(1);

    // Replay within the same instance: nothing new happened on chain.
    expect(await watcherA.poll()).toEqual([]);

    // Restart. FALSIFY=CF-04: the checkpoint is dropped — the restarted
    // watcher re-walks the whole window from the pre-deposit start.
    const checkpoint = falsifyActive('CF-04') ? startCheckpoint : watcherA.checkpoint();
    const watcherB = ChainWatcher.fromCheckpoint(node, watched, checkpoint);
    const replayCredits = (await watcherB.poll()).filter((e) => e.kind === 'credited');

    // Exactly one credit per deposit, EVER — across every watcher instance.
    expect(creditEvents.length + replayCredits.length).toBe(1);

    // The restarted watcher converges to the identical state.
    expect(snapshotTrackerState(watcherB.state)).toEqual(snapshotTrackerState(watcherA.state));

    // Second observer agreement at the final tip.
    const walletView = (await watch.listUnspent(1, [address])).filter((u) => u.txid === txid);
    expect(walletView).toHaveLength(1);
    expect(walletView[0]?.amountSats).toBe(DEPOSIT_SATS);
    expect(walletView[0]?.confirmations).toBe(N);
  });
});
