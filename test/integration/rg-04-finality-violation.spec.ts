/**
 * RG-04 — a reorg deeper than finality: sticky credit plus a
 * FINALITY_VIOLATION alarm, never a silent balance change.
 *
 * Chain events driven: deposit; mine to N (credit fires); invalidate the
 *   containing block — a reorg N deep — and mine a 7-block competing
 *   chain without the deposit.
 * Invariant: the credited record does NOT change (state, creditedAtHeight,
 *   amount all sticky; still exactly one credit event) and exactly one
 *   FINALITY_VIOLATION event fires; the wallet meanwhile reports the tx
 *   back at 0 confirmations — the deliberate divergence the alarm exists
 *   to surface (ADR-0002: alert, human decision, no silent clawback).
 * Custody risk: silent insolvency (or an equally silent clawback) after a
 *   finality-depth failure.
 * Falsification lever: FALSIFY=RG-04 suppresses the alert view; the
 *   exactly-one-violation assertion goes red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { type TrackerEvent } from '../../src/core/confirmations.js';
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
const DEPOSIT_SATS = 2_020_202n;
const ADDRESS_INDEX = 23;

describe('RG-04: deeper-than-finality reorg — sticky credit, loud alarm', () => {
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

  it('keeps the credit, raises exactly one FINALITY_VIOLATION', async () => {
    const watcher = await ChainWatcher.create(node, new Set([address]), N);
    const allEvents: TrackerEvent[] = [];

    const txid = await signing.sendToAddress(address, DEPOSIT_SATS, 25);
    allEvents.push(...(await watcher.poll()));
    await mineToWallet(node, signing, N);
    allEvents.push(...(await watcher.poll()));

    const recordNow = () => {
      const record = [...watcher.state.records.values()].find((r) => r.outpoint.txid === txid);
      expect(record).toBeDefined();
      if (record === undefined) {
        throw new Error('deposit record missing');
      }
      return record;
    };

    const credited = recordNow();
    expect(credited.state).toBe('CREDITED');
    expect(credited.inclusion).not.toBeNull();
    if (credited.inclusion === null) {
      return;
    }
    const creditedAtHeight = credited.creditedAtHeight;
    expect(allEvents.filter((e) => e.kind === 'credited')).toHaveLength(1);

    // Reorg N deep: invalidate the inclusion block itself.
    await node.invalidateBlock(credited.inclusion.blockHash);
    const minerAddress = await signing.getNewAddress();
    for (let i = 0; i < N + 1; i += 1) {
      await node.generateBlock(minerAddress, []);
    }
    allEvents.push(...(await watcher.poll()));

    const after = recordNow();
    expect(after.state).toBe('CREDITED'); // sticky
    expect(after.creditedAtHeight).toBe(creditedAtHeight);
    expect(after.amountSats).toBe(DEPOSIT_SATS);
    expect(after.inclusion).toBeNull();
    expect(allEvents.filter((e) => e.kind === 'credited')).toHaveLength(1);

    // FALSIFY=RG-04: the alert is dropped on the floor.
    const violations = falsifyActive('RG-04')
      ? []
      : allEvents.filter((e) => e.kind === 'finality-violation');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.outpoint.txid).toBe(txid);

    // The wallet now disagrees on purpose: that divergence is the alarm's
    // whole reason to exist.
    expect((await watch.getTransaction(txid)).confirmations).toBe(0);
  });
});
