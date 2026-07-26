/**
 * RG-03 — the competing chain double-spends the deposit's input: the one
 * way a deposit dies for good.
 *
 * Chain events driven: deposit; mine 2; invalidate the containing block
 *   (deposit resurrects to the mempool); pin that the underpaying
 *   conflicting spend is refused by full-RBF mempool policy
 *   ("insufficient fee, rejecting replacement") [pin]; mine it directly
 *   via generateblock-with-raw-tx — blocks are not bound by mempool
 *   policy; mine 2 more.
 * Invariant: the tracker marks the deposit CONFLICTED — terminal, never
 *   credited (zero credit events); the wallet oracle reports NEGATIVE
 *   confirmations equal to minus the conflicting tx's depth [pin], and
 *   listsinceblock include_removed lists the deposit as removed.
 * Custody risk: double-spend fraud passing unnoticed — the attack reorgs
 *   exist for.
 * Falsification lever: FALSIFY=RG-03 views CONFLICTED as still-pending;
 *   the terminal-state assertion goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { satsToBtc } from '../../src/rpc/amount.js';
import type { BitcoindRpc } from '../../src/rpc/bitcoind.js';
import { RpcError } from '../../src/rpc/client.js';
import { falsifyActive } from '../../src/testing/falsify.js';
import { type DepositStateKind, type TrackerEvent } from '../../src/core/confirmations.js';
import { deriveAddress } from '../../src/core/derivation.js';
import {
  connectRegtest,
  ensureSpendableFunds,
  mineToWallet,
  openSigningWallet,
} from '../../src/testing/node.js';
import { ChainWatcher } from '../../src/watcher/watcher.js';
import { watchOnlyFixture } from '../support/watch-setup.js';

const N = 6;
const DEPOSIT_SATS = 4_040_404n;
// Deliberately below the deposit's absolute fee: with full-RBF (Core 29+)
// a well-funded conflict would simply REPLACE the deposit in the mempool,
// which is a different phenomenon than the mined-double-spend RG-03 pins.
const CONFLICT_FEE_SATS = 1_000n;
const ADDRESS_INDEX = 22;

describe('RG-03: conflicting spend conflicts the deposit for good', () => {
  const node = connectRegtest();
  let signing: BitcoindRpc;
  let watch: BitcoindRpc;
  let address: string;

  beforeAll(async () => {
    signing = await openSigningWallet(node);
    const fixture = await watchOnlyFixture(node);
    watch = fixture.watch;
    address = deriveAddress(fixture.account, 'receive', ADDRESS_INDEX);
    await ensureSpendableFunds(node, signing, DEPOSIT_SATS + 20_000_000n);
  });

  it('CONFLICTED terminal, never credited; wallet shows negative confirmations', async () => {
    const watcher = await ChainWatcher.create(node, new Set([address]), N);
    const allEvents: TrackerEvent[] = [];

    const txid = await signing.sendToAddress(address, DEPOSIT_SATS, 25);
    allEvents.push(...(await watcher.poll()));
    await mineToWallet(node, signing, 2);
    allEvents.push(...(await watcher.poll()));

    const included = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
    expect(included?.inclusion).not.toBeNull();
    if (included?.inclusion == null) {
      return;
    }

    // Build the conflicting spend of the deposit's first input.
    const inputs = await node.getRawTransactionInputs(txid);
    const disputed = inputs[0];
    expect(disputed).toBeDefined();
    if (disputed === undefined) {
      return;
    }
    // Determinism guard: the disputed outpoint must be chain-confirmed, or
    // generateblock would reject the conflicting block outright.
    expect((await signing.getTransaction(disputed.txid)).confirmations).toBeGreaterThanOrEqual(1);
    const parentOutputs = await node.getRawTransactionOutputs(disputed.txid);
    const disputedValue = parentOutputs.find((o) => o.vout === disputed.vout)?.valueSats;
    expect(disputedValue).toBeDefined();
    if (disputedValue === undefined) {
      return;
    }
    const unsignedConflict = await node.createRawTransaction([disputed], {
      [await signing.getNewAddress()]: satsToBtc(disputedValue - CONFLICT_FEE_SATS),
    });
    const conflict = await signing.signRawTransactionWithWallet(unsignedConflict);
    expect(conflict.complete).toBe(true);

    // Reorg the deposit back into the mempool…
    const preReorgTip = await node.getBestBlockHash();
    await node.invalidateBlock(included.inclusion.blockHash);

    // [pin] …where the underpaying conflict cannot follow it in: full-RBF
    // evaluates it as a replacement and rejects it on fees.
    let refused: unknown;
    try {
      await node.sendRawTransaction(conflict.hex);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(RpcError);
    expect((refused as RpcError).rpcMessage).toContain('insufficient fee, rejecting replacement');

    // So it is mined directly — the competing chain carries the conflict.
    await node.generateBlock(await signing.getNewAddress(), [conflict.hex]);
    await mineToWallet(node, signing, 2);
    allEvents.push(...(await watcher.poll()));

    const record = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
    expect(record).toBeDefined();
    if (record === undefined) {
      return;
    }
    // FALSIFY=RG-03: a view that keeps treating conflicted as pending.
    const stateView: DepositStateKind =
      falsifyActive('RG-03') && record.state === 'CONFLICTED' ? 'SEEN_MEMPOOL' : record.state;
    expect(stateView).toBe('CONFLICTED');
    expect(record.inclusion).toBeNull();
    expect(record.creditedAtHeight).toBeNull();
    expect(allEvents.filter((e) => e.kind === 'credited')).toHaveLength(0);

    // Wallet oracle [pin]: negative confirmations = −(conflicting tx depth),
    // and listsinceblock from the DETACHED pre-reorg tip walks the orphaned
    // branch into `removed`.
    expect((await watch.getTransaction(txid)).confirmations).toBe(-3);
    const since = await watch.listSinceBlock(preReorgTip);
    expect(since.removed.some((t) => t.txid === txid)).toBe(true);
  });
});
