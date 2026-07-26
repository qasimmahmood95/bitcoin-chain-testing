/**
 * RG-05 — chain flapping A→B→A converges to the never-reorged state with
 * exactly one credit.
 *
 * Chain events driven: deposit; mine 3 on chain A; invalidate A's deposit
 *   block and mine a 4-block empty chain B; reconsider A's block and
 *   invalidate B's first block — the node is back on the original chain A
 *   exactly; mine to N on A.
 * Invariant: after flapping back, the record equals its pre-flap self
 *   (same inclusion block, same confirmations); credit then fires at the
 *   height it would have reached with no reorg at all, exactly once across
 *   the entire run; the wallet agrees on final confirmations.
 * Custody risk: state corruption under repeated tip churn (unstable
 *   peers, eclipse recovery).
 * Falsification lever: FALSIFY=RG-05 replays the window through a fresh
 *   watcher with no checkpoint and counts its re-emitted credit too — the
 *   exactly-once assertion goes red.
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
const DEPOSIT_SATS = 5_050_505n;
const ADDRESS_INDEX = 24;

describe('RG-05: A→B→A flapping converges with a single credit', () => {
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

  it('final state equals the no-reorg run; exactly one credit ever', async () => {
    const watcher = await ChainWatcher.create(node, new Set([address]), N);
    const preDepositCheckpoint = watcher.checkpoint();
    const allEvents: TrackerEvent[] = [];

    const txid = await signing.sendToAddress(address, DEPOSIT_SATS, 25);
    allEvents.push(...(await watcher.poll()));
    await mineToWallet(node, signing, 3);
    allEvents.push(...(await watcher.poll()));

    const recordNow = () => {
      const record = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
      expect(record).toBeDefined();
      if (record === undefined) {
        throw new Error('deposit record missing');
      }
      return record;
    };

    const preFlap = recordNow();
    expect(preFlap.inclusion).not.toBeNull();
    if (preFlap.inclusion === null) {
      return;
    }
    const inclusionHashA = preFlap.inclusion.blockHash;
    const inclusionHeightA = preFlap.inclusion.height;

    // A → B: invalidate the deposit block, mine 4 empty blocks.
    await node.invalidateBlock(inclusionHashA);
    const minerAddress = await signing.getNewAddress();
    const chainBFirst = await node.generateBlock(minerAddress, []);
    for (let i = 0; i < 3; i += 1) {
      await node.generateBlock(minerAddress, []);
    }
    allEvents.push(...(await watcher.poll()));
    expect(recordNow().state).toBe('SEEN_MEMPOOL'); // demoted on B

    // B → A: revalidate A, invalidate B — the node is back on A exactly.
    await node.reconsiderBlock(inclusionHashA);
    await node.invalidateBlock(chainBFirst);
    allEvents.push(...(await watcher.poll()));

    const postFlap = recordNow();
    expect(postFlap.state).toBe('CONFIRMING');
    expect(postFlap.inclusion?.blockHash).toBe(inclusionHashA);
    expect(postFlap.inclusion?.height).toBe(inclusionHeightA);
    expect(confirmationsOf(postFlap, watcher.state.tipHeight)).toBe(3);

    // On to finality, as if nothing ever happened.
    await mineToWallet(node, signing, N - 3);
    allEvents.push(...(await watcher.poll()));

    const final = recordNow();
    expect(final.state).toBe('CREDITED');
    expect(final.inclusion?.blockHash).toBe(inclusionHashA);
    expect(final.creditedAtHeight).toBe(inclusionHeightA + N - 1); // the no-reorg height
    expect(confirmationsOf(final, watcher.state.tipHeight)).toBe(N);
    expect((await watch.getTransaction(txid)).confirmations).toBe(N);

    // Exactly one credit across the whole flap.
    const credits = allEvents.filter((e) => e.kind === 'credited');
    // FALSIFY=RG-05: replay the window with no checkpoint — the re-walk
    // re-emits the credit and the count breaks.
    if (falsifyActive('RG-05')) {
      const replay = ChainWatcher.fromCheckpoint(node, new Set([address]), preDepositCheckpoint);
      credits.push(...(await replay.poll()).filter((e) => e.kind === 'credited'));
    }
    expect(credits).toHaveLength(1);
  });
});
