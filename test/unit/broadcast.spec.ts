/**
 * BR-SM (unit) — broadcast outcomes classify exactly, and folding them
 * into a withdrawal record makes retries free and conflicts terminal.
 *
 * Chain events driven: none (pure — recorded RPC error shapes).
 * Invariant: -27 maps to already-mined, -25/-26 to a typed conflict, any
 *   other code throws unclassified (never guessed); repeated application
 *   of accepted/already-mined/repeat-rejection outcomes leaves the record
 *   byte-identical; a conflict lands in terminal `failed` exactly once;
 *   contradictory feeds throw rather than corrupt.
 * Custody risk: retry-storm double-debit; withdrawals stuck in-flight
 *   forever; misclassified rejections silently fabricating accounting.
 * Falsification lever: FALSIFY=BR-SM corrupts the retried record before
 *   the byte-identical assertion — the idempotency pin goes red.
 */

import { describe, expect, it } from 'vitest';
import {
  applyBroadcastOutcome,
  BroadcastStateError,
  classifyBroadcastResult,
  initialWithdrawal,
  UnclassifiedBroadcastError,
  type WithdrawalRecord,
} from '../../src/core/broadcast.js';
import { falsifyActive } from '../../src/testing/falsify.js';

const TXID = 'a'.repeat(64);

describe('classifyBroadcastResult', () => {
  it('maps the pinned RPC codes to typed outcomes', () => {
    expect(classifyBroadcastResult({ kind: 'sent', txid: TXID }, TXID)).toEqual({
      kind: 'accepted',
    });
    expect(
      classifyBroadcastResult(
        { kind: 'rpc-error', code: -27, message: 'Transaction outputs already in utxo set' },
        TXID,
      ),
    ).toEqual({ kind: 'already-mined' });
    expect(
      classifyBroadcastResult(
        { kind: 'rpc-error', code: -25, message: 'bad-txns-inputs-missingorspent' },
        TXID,
      ),
    ).toEqual({ kind: 'rejected-conflict', reason: 'bad-txns-inputs-missingorspent' });
    expect(
      classifyBroadcastResult(
        { kind: 'rpc-error', code: -26, message: 'insufficient fee, rejecting replacement' },
        TXID,
      ),
    ).toEqual({ kind: 'rejected-conflict', reason: 'insufficient fee, rejecting replacement' });
  });

  it('refuses to guess: unknown codes and foreign txids throw', () => {
    expect(() =>
      classifyBroadcastResult({ kind: 'rpc-error', code: -22, message: 'TX decode failed' }, TXID),
    ).toThrow(UnclassifiedBroadcastError);
    expect(() => classifyBroadcastResult({ kind: 'sent', txid: 'b'.repeat(64) }, TXID)).toThrow(
      BroadcastStateError,
    );
  });

  it('refuses to guess: -25/-26 outside the pinned messages are NOT conflicts', () => {
    // -25 also carries maxfee refusals — config sanity, not a conflict.
    expect(() =>
      classifyBroadcastResult(
        {
          kind: 'rpc-error',
          code: -25,
          message: 'Fee exceeds maximum configured by user (e.g. -maxtxfee, maxfeerate)',
        },
        TXID,
      ),
    ).toThrow(UnclassifiedBroadcastError);
    // -26 is the generic policy bucket; these are transient, not terminal.
    for (const message of ['min relay fee not met', 'dust', 'too-long-mempool-chain']) {
      expect(() =>
        classifyBroadcastResult({ kind: 'rpc-error', code: -26, message }, TXID),
      ).toThrow(UnclassifiedBroadcastError);
    }
  });
});

describe('applyBroadcastOutcome', () => {
  it('retries are free: accepted and already-mined never mutate the record', () => {
    const record = initialWithdrawal(TXID);
    const baseline = JSON.stringify(record);
    let retried: WithdrawalRecord = record;
    for (const kind of ['accepted', 'accepted', 'already-mined', 'accepted'] as const) {
      retried = applyBroadcastOutcome(retried, { kind });
      // FALSIFY=BR-SM: a per-attempt mutation slips into the record.
      if (falsifyActive('BR-SM')) {
        retried = { ...retried, failureReason: 'attempt noted' };
      }
      expect(JSON.stringify(retried)).toBe(baseline);
    }
  });

  it('a conflict is terminal failed, exactly once, with the reason kept', () => {
    const record = initialWithdrawal(TXID);
    const failed = applyBroadcastOutcome(record, {
      kind: 'rejected-conflict',
      reason: 'bad-txns-inputs-missingorspent',
    });
    expect(failed).toEqual({
      txid: TXID,
      state: 'failed',
      failureReason: 'bad-txns-inputs-missingorspent',
    });
    // Repeat rejections are a no-op on the terminal record.
    const again = applyBroadcastOutcome(failed, {
      kind: 'rejected-conflict',
      reason: 'bad-txns-inputs-missingorspent',
    });
    expect(again).toEqual(failed);
  });

  it('outcomes contradicting a terminal failed record throw, never corrupt', () => {
    const failed = applyBroadcastOutcome(initialWithdrawal(TXID), {
      kind: 'rejected-conflict',
      reason: 'bad-txns-inputs-missingorspent',
    });
    expect(() => applyBroadcastOutcome(failed, { kind: 'accepted' })).toThrow(BroadcastStateError);
    expect(() => applyBroadcastOutcome(failed, { kind: 'already-mined' })).toThrow(
      BroadcastStateError,
    );
  });
});
