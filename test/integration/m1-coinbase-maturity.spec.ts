/**
 * M1 characterization — the coinbase-maturity boundary at the mempool. [pin]
 *
 * Chain events driven: mine COINBASE_MATURITY+1 (101) blocks to an
 *   ephemeral node-side signing wallet, then attempt consensus-level spends
 *   of the coinbases now at depths 99, 100, and 101 — the boundary asserted
 *   as a triplet at one tip, no mining between asserts.
 * Invariant: mempool acceptance evaluates maturity against the NEXT block
 *   (Core passes nSpendHeight = tip+1 to CheckTxInputs): the depth-99 spend
 *   is rejected with exactly "bad-txns-premature-spend-of-coinbase"; the
 *   depth-100 spend is accepted and broadcasts (it would first confirm at
 *   depth 101); the depth-101 spend is accepted. A coinbase spend therefore
 *   first *confirms* at depth 101 — why funding fixtures mine 101 blocks.
 * Custody risk: treating miner-funded deposits as spendable a block early —
 *   funds consensus can still take back — or refusing them a block late and
 *   stalling withdrawals. Both sides of the boundary are pinned.
 * Falsification lever: FALSIFY=MATURITY mines one extra block before the
 *   asserts, shifting every depth up by one — the block asserted as
 *   depth-99-rejected is then at depth 100, and the rejection assertion
 *   goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { satsToBtc } from '../../src/rpc/amount.js';
import type { BitcoindRpc } from '../../src/rpc/bitcoind.js';
import { falsifyActive } from '../../src/testing/falsify.js';
import {
  COINBASE_MATURITY,
  connectRegtest,
  mineToWallet,
  openSigningWallet,
} from '../../src/testing/node.js';

const FEE_SATS = 10_000n;

describe('M1 characterization: coinbase maturity', () => {
  const node = connectRegtest();
  let wallet: BitcoindRpc;
  let heightBefore: number;
  let minedHashes: string[];

  beforeAll(async () => {
    wallet = await openSigningWallet(node);
    heightBefore = await node.getBlockCount();
    // FALSIFY=MATURITY: one extra block shifts every asserted depth by one.
    const blocks = COINBASE_MATURITY + 1 + (falsifyActive('MATURITY') ? 1 : 0);
    minedHashes = await mineToWallet(node, wallet, blocks);
  });

  async function signedCoinbaseSpend(blockHash: string): Promise<string> {
    const coinbase = await node.getCoinbaseOutpoint(blockHash);
    const destination = await wallet.getNewAddress();
    const unsigned = await node.createRawTransaction(
      [{ txid: coinbase.txid, vout: coinbase.vout }],
      { [destination]: satsToBtc(coinbase.valueSats - FEE_SATS) },
    );
    const signed = await wallet.signRawTransactionWithWallet(unsigned);
    expect(signed.complete).toBe(true);
    return signed.hex;
  }

  it('mining happened only because this test asked for it', async () => {
    expect(minedHashes).toHaveLength(COINBASE_MATURITY + 1);
    expect(await node.getBlockCount()).toBe(heightBefore + COINBASE_MATURITY + 1);
  });

  it('pins the mempool maturity boundary: depth 99 rejected, 100 accepted, 101 accepted', async () => {
    // With tip at heightBefore+101: minedHashes[0] is at depth 101,
    // minedHashes[1] at depth 100, minedHashes[2] at depth 99.
    const depth101Hash = minedHashes.at(0);
    const depth100Hash = minedHashes.at(1);
    const depth99Hash = minedHashes.at(2);
    expect(depth101Hash).toBeDefined();
    expect(depth100Hash).toBeDefined();
    expect(depth99Hash).toBeDefined();
    if (depth101Hash === undefined || depth100Hash === undefined || depth99Hash === undefined) {
      return;
    }

    const prematureSpend = await signedCoinbaseSpend(depth99Hash);
    const [prematureResult] = await node.testMempoolAccept([prematureSpend]);
    expect(prematureResult?.allowed).toBe(false);
    expect(prematureResult?.rejectReason).toBe('bad-txns-premature-spend-of-coinbase');

    const boundarySpend = await signedCoinbaseSpend(depth100Hash);
    const [boundaryResult] = await node.testMempoolAccept([boundarySpend]);
    expect(boundaryResult?.rejectReason).toBeUndefined();
    expect(boundaryResult?.allowed).toBe(true);

    const matureSpend = await signedCoinbaseSpend(depth101Hash);
    const [matureResult] = await node.testMempoolAccept([matureSpend]);
    expect(matureResult?.rejectReason).toBeUndefined();
    expect(matureResult?.allowed).toBe(true);

    const txid = await node.sendRawTransaction(boundarySpend);
    expect(await node.getRawMempool()).toContain(txid);
  });
});
