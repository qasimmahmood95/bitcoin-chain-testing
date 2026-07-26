/**
 * M1 characterization — coinbase maturity boundary. [pin]
 *
 * Chain events driven: mine COINBASE_MATURITY+1 (101) blocks to an
 *   ephemeral node-side signing wallet, then attempt consensus-level spends
 *   of the coinbases now at depth 100 and depth 101 — the boundary is
 *   asserted from both sides at the same tip, no mining between asserts.
 * Invariant: the depth-100 spend is rejected with exactly
 *   "bad-txns-premature-spend-of-coinbase"; the depth-101 spend is accepted
 *   and broadcasts into the mempool.
 * Custody risk: crediting miner-funded deposits one block early — funds
 *   consensus can still take back. Also the ground truth under every later
 *   funding fixture (mine 101 before first spend).
 * Falsification lever: FALSIFY=MATURITY (harness lands M2) mines one block
 *   fewer; the depth-101 acceptance goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { satsToBtc } from '../../src/rpc/amount.js';
import type { BitcoindRpc } from '../../src/rpc/bitcoind.js';
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
    minedHashes = await mineToWallet(node, wallet, COINBASE_MATURITY + 1);
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

  it('rejects a coinbase spend at depth 100 and accepts the same shape at depth 101', async () => {
    // minedHashes[0] is now at depth 101 (mature), minedHashes[1] at depth 100.
    const matureHash = minedHashes.at(0);
    const immatureHash = minedHashes.at(1);
    expect(matureHash).toBeDefined();
    expect(immatureHash).toBeDefined();
    if (matureHash === undefined || immatureHash === undefined) {
      return;
    }

    const immatureSpend = await signedCoinbaseSpend(immatureHash);
    const [immatureResult] = await node.testMempoolAccept([immatureSpend]);
    expect(immatureResult?.allowed).toBe(false);
    expect(immatureResult?.rejectReason).toBe('bad-txns-premature-spend-of-coinbase');

    const matureSpend = await signedCoinbaseSpend(matureHash);
    const [matureResult] = await node.testMempoolAccept([matureSpend]);
    expect(matureResult?.rejectReason).toBeUndefined();
    expect(matureResult?.allowed).toBe(true);

    const txid = await node.sendRawTransaction(matureSpend);
    expect(await node.getRawMempool()).toContain(txid);
  });
});
