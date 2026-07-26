/**
 * RG-01 — THE HEADLINE: a deposit reorged out before finality depth
 * un-credits; "reorged out" means demoted, not gone.
 *
 * Chain events driven: deposit; mine 3 (depth 3 < N=6); invalidate the
 *   containing block; mine a 4-block competing chain WITHOUT the deposit
 *   (generateblock with empty tx lists — generatetoaddress would re-mine
 *   the resurrected tx).
 * Invariant: the tracker reverts the deposit to SEEN_MEMPOOL / 0
 *   confirmations; credited=false THROUGHOUT (zero credit events across
 *   every poll); the wallet oracle agrees (listsinceblock include_removed
 *   surfaces the tx as removed AND as unconfirmed again [pin];
 *   gettransaction shows 0 confirmations).
 * Custody risk: crediting money the chain no longer contains — the exact
 *   insolvency mechanism reorgs enable.
 * Falsification lever: FALSIFY=RG-01 suppresses the reorg (no
 *   invalidateblock) — the competing blocks extend the original chain
 *   instead, the deposit confirms deeper, and the un-credit assertions go
 *   red.
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
const DEPOSIT_SATS = 6_060_606n;
const ADDRESS_INDEX = 20;

describe('RG-01: reorged-out deposit un-credits', () => {
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

  it('reverts to SEEN_MEMPOOL with zero credit events, in both observers', async () => {
    const watcher = await ChainWatcher.create(node, new Set([address]), N);
    const allEvents: TrackerEvent[] = [];
    const baseHash = await node.getBestBlockHash();

    const txid = await signing.sendToAddress(address, DEPOSIT_SATS, 25);
    allEvents.push(...(await watcher.poll()));
    await mineToWallet(node, signing, 3);
    allEvents.push(...(await watcher.poll()));

    const included = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
    expect(included?.state).toBe('CONFIRMING');
    expect(included?.inclusion).not.toBeNull();
    if (included?.inclusion == null) {
      return;
    }

    // FALSIFY=RG-01: the reorg never happens — the assertions below must
    // notice that nothing was un-credited.
    if (!falsifyActive('RG-01')) {
      await node.invalidateBlock(included.inclusion.blockHash);
    }
    const minerAddress = await signing.getNewAddress();
    for (let i = 0; i < 4; i += 1) {
      await node.generateBlock(minerAddress, []);
    }
    allEvents.push(...(await watcher.poll()));

    const record = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
    expect(record).toBeDefined();
    if (record === undefined) {
      return;
    }
    expect(record.state).toBe('SEEN_MEMPOOL');
    expect(record.inclusion).toBeNull();
    expect(record.creditedAtHeight).toBeNull();
    expect(confirmationsOf(record, watcher.state.tipHeight)).toBe(0);

    // credited=false THROUGHOUT: not one credit event across the whole run.
    expect(allEvents.filter((e) => e.kind === 'credited')).toHaveLength(0);

    // Wallet oracle [pin]: the tx is in `removed` (its block disconnected)
    // AND back in `transactions` at 0 confirmations (mempool resurrection).
    const since = await watch.listSinceBlock(baseHash);
    expect(since.removed.some((t) => t.txid === txid)).toBe(true);
    const resurfaced = since.transactions.filter((t) => t.txid === txid);
    expect(resurfaced.length).toBeGreaterThan(0);
    expect(resurfaced.every((t) => t.confirmations === 0)).toBe(true);
    expect((await watch.getTransaction(txid)).confirmations).toBe(0);
  });
});
