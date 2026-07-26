/**
 * CF-05 — aggregation is per outpoint: one transaction paying two watched
 * addresses, and two deposits to one address.
 *
 * Chain events driven: one sendmany paying two watched addresses; two
 *   separate sends to a third watched address; mine to N.
 * Invariant: one deposit record per (txid,vout) outpoint — four in total —
 *   each credited exactly once at N with its exact amount; the wallet
 *   sees the same four UTXOs.
 * Custody risk: aggregation bugs — under-credit loses client funds,
 *   over-credit loses house funds.
 * Falsification lever: FALSIFY=CF-05 keys the spec's distinctness check on
 *   txid instead of outpoint; the four-records assertion goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { outpointKey } from '../../src/core/confirmations.js';
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
const AMOUNT_A = 1_111_111n;
const AMOUNT_B = 2_222_222n;
const AMOUNT_C1 = 3_333_333n;
const AMOUNT_C2 = 4_444_444n;

describe('CF-05: one record per outpoint', () => {
  const node = connectRegtest();
  let signing: BitcoindRpc;
  let watch: BitcoindRpc;
  let addressA: string;
  let addressB: string;
  let addressC: string;

  beforeAll(async () => {
    signing = await openSigningWallet(node);
    const fixture = await watchOnlyFixture(node);
    watch = fixture.watch;
    addressA = deriveAddress(fixture.account, 'receive', 14);
    addressB = deriveAddress(fixture.account, 'receive', 15);
    addressC = deriveAddress(fixture.account, 'receive', 16);
    await ensureSpendableFunds(
      node,
      signing,
      AMOUNT_A + AMOUNT_B + AMOUNT_C1 + AMOUNT_C2 + 50_000_000n,
    );
  });

  it('four outpoints, four records, four credits, both observers agree', async () => {
    const watcher = await ChainWatcher.create(node, new Set([addressA, addressB, addressC]), N);

    const multiTxid = await signing.sendMany({ [addressA]: AMOUNT_A, [addressB]: AMOUNT_B }, 25);
    const txidC1 = await signing.sendToAddress(addressC, AMOUNT_C1, 25);
    const txidC2 = await signing.sendToAddress(addressC, AMOUNT_C2, 25);

    await watcher.poll();
    await mineToWallet(node, signing, N);
    const credits = (await watcher.poll()).filter((e) => e.kind === 'credited');

    const records = [...watcher.state.records.values()];
    // FALSIFY=CF-05: distinctness keyed on txid collapses the sendmany pair.
    const keyOf = falsifyActive('CF-05')
      ? (r: (typeof records)[number]) => r.outpoint.txid
      : (r: (typeof records)[number]) => outpointKey(r.outpoint);
    expect(new Set(records.map(keyOf)).size).toBe(4);
    expect(records).toHaveLength(4);

    // The one transaction paying two watched addresses → two records.
    const fromMulti = records.filter((r) => r.outpoint.txid === multiTxid);
    expect(fromMulti).toHaveLength(2);
    expect(new Set(fromMulti.map((r) => r.outpoint.vout)).size).toBe(2);
    expect(new Set(fromMulti.map((r) => r.amountSats))).toEqual(new Set([AMOUNT_A, AMOUNT_B]));
    expect(new Set(fromMulti.map((r) => r.address))).toEqual(new Set([addressA, addressB]));

    // Two deposits to one address → two records with distinct txids.
    const atC = records.filter((r) => r.address === addressC);
    expect(atC).toHaveLength(2);
    expect(new Set(atC.map((r) => r.outpoint.txid))).toEqual(new Set([txidC1, txidC2]));
    expect(new Set(atC.map((r) => r.amountSats))).toEqual(new Set([AMOUNT_C1, AMOUNT_C2]));

    // Every record credited, exactly one credit event per outpoint.
    for (const record of records) {
      expect(record.state, outpointKey(record.outpoint)).toBe('CREDITED');
    }
    expect(credits).toHaveLength(4);
    expect(new Set(credits.map((e) => outpointKey(e.outpoint))).size).toBe(4);

    // Second observer: same four UTXOs, same amounts, N confirmations.
    for (const [address, expected] of [
      [addressA, [AMOUNT_A]],
      [addressB, [AMOUNT_B]],
      [addressC, [AMOUNT_C1, AMOUNT_C2]],
    ] as const) {
      const bySats = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
      const utxos = (await watch.listUnspent(1, [address])).filter(
        (u) => u.txid === multiTxid || u.txid === txidC1 || u.txid === txidC2,
      );
      expect(utxos.map((u) => u.amountSats).sort(bySats)).toEqual([...expected].sort(bySats));
      for (const utxo of utxos) {
        expect(utxo.confirmations).toBe(N);
      }
    }
  });
});
