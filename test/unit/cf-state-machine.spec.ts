/**
 * Unit — the confirmation-depth state machine's transition pins (ADR-0002;
 * underpins CF-01/CF-02, and the reorg policies M4 drives live).
 *
 * Chain events driven: none (pure — synthetic event sequences).
 * Invariant: credit flips exactly at N confirmations and latches exactly
 *   once; disconnect reverts uncredited deposits to SEEN_MEMPOOL but never
 *   touches a credit (FINALITY_VIOLATION alert instead); CONFLICTED is
 *   terminal and never credited; malformed sequences throw, never corrupt.
 * Custody risk: off-by-one premature credit; double-credit; silent
 *   clawback after a finality failure — each an insolvency mechanism.
 * Falsification lever: FALSIFY=CF-SM builds the fixture tracker with
 *   finality depth N−1; the boundary triplet goes red.
 */

import { describe, expect, it } from 'vitest';
import {
  applyChainEvent,
  ChainEventError,
  confirmationsOf,
  initialTrackerState,
  outpointKey,
  restoreTrackerState,
  snapshotTrackerState,
  type ChainEvent,
  type TrackerEvent,
  type TrackerState,
  type WatchedDeposit,
} from '../../src/core/confirmations.js';
import { falsifyActive } from '../../src/testing/falsify.js';

const N = 6;
const START_HEIGHT = 100;

// FALSIFY=CF-SM: one confirmation early — the classic premature credit.
function newTracker(): TrackerState {
  return initialTrackerState(falsifyActive('CF-SM') ? N - 1 : N, START_HEIGHT);
}

const DEPOSIT: WatchedDeposit = {
  outpoint: { txid: 'a'.repeat(64), vout: 0 },
  address: 'bcrt1qwatched',
  amountSats: 12_345_678n,
};

interface Run {
  state: TrackerState;
  events: TrackerEvent[];
}

function run(state: TrackerState, events: readonly ChainEvent[]): Run {
  const collected: TrackerEvent[] = [];
  let current = state;
  for (const event of events) {
    const transition = applyChainEvent(current, event);
    current = transition.state;
    collected.push(...transition.events);
  }
  return { state: current, events: collected };
}

function connectAt(height: number, deposits: readonly WatchedDeposit[] = []): ChainEvent {
  return { kind: 'connect', height, blockHash: `hash-${String(height)}`, deposits };
}

function emptyConnects(fromHeight: number, count: number): ChainEvent[] {
  return Array.from({ length: count }, (_, i) => connectAt(fromHeight + i));
}

function recordOf(state: TrackerState) {
  const record = state.records.get(outpointKey(DEPOSIT.outpoint));
  expect(record).toBeDefined();
  if (record === undefined) {
    throw new Error('unreachable');
  }
  return record;
}

describe('confirmation state machine', () => {
  it('credits exactly at N confirmations — boundary triplet', () => {
    // Include at START+1, then mine to N−1 / N / N+1 confirmations.
    const included = run(newTracker(), [
      { kind: 'mempool', deposit: DEPOSIT },
      connectAt(START_HEIGHT + 1, [DEPOSIT]),
      ...emptyConnects(START_HEIGHT + 2, N - 2),
    ]);
    // Tip = START+N−1 → confirmations = N−1: not credited.
    expect(confirmationsOf(recordOf(included.state), included.state.tipHeight)).toBe(N - 1);
    expect(recordOf(included.state).state).toBe('CONFIRMING');
    expect(included.events).toEqual([]);

    const atN = run(included.state, [connectAt(START_HEIGHT + N)]);
    expect(confirmationsOf(recordOf(atN.state), atN.state.tipHeight)).toBe(N);
    expect(recordOf(atN.state).state).toBe('CREDITED');
    expect(recordOf(atN.state).creditedAtHeight).toBe(START_HEIGHT + N);
    expect(atN.events).toEqual([
      { kind: 'credited', outpoint: DEPOSIT.outpoint, atHeight: START_HEIGHT + N },
    ]);

    const pastN = run(atN.state, [connectAt(START_HEIGHT + N + 1)]);
    expect(recordOf(pastN.state).state).toBe('CREDITED');
    expect(recordOf(pastN.state).creditedAtHeight).toBe(START_HEIGHT + N);
    expect(pastN.events).toEqual([]); // never a second credit
  });

  it('a mempool-only deposit never credits, regardless of blocks mined', () => {
    const result = run(newTracker(), [
      { kind: 'mempool', deposit: DEPOSIT },
      ...emptyConnects(START_HEIGHT + 1, N + 3),
    ]);
    expect(recordOf(result.state).state).toBe('SEEN_MEMPOOL');
    expect(confirmationsOf(recordOf(result.state), result.state.tipHeight)).toBe(0);
    expect(result.events).toEqual([]);
  });

  it('disconnect before credit reverts to SEEN_MEMPOOL — demoted, not gone', () => {
    const result = run(newTracker(), [
      connectAt(START_HEIGHT + 1, [DEPOSIT]),
      connectAt(START_HEIGHT + 2),
      {
        kind: 'disconnect',
        height: START_HEIGHT + 2,
        blockHash: `hash-${String(START_HEIGHT + 2)}`,
      },
      {
        kind: 'disconnect',
        height: START_HEIGHT + 1,
        blockHash: `hash-${String(START_HEIGHT + 1)}`,
      },
    ]);
    const record = recordOf(result.state);
    expect(record.state).toBe('SEEN_MEMPOOL');
    expect(record.inclusion).toBeNull();
    expect(result.events).toEqual([]);
  });

  it('disconnect that reaches a credit raises FINALITY_VIOLATION and keeps the credit', () => {
    const credited = run(newTracker(), [
      connectAt(START_HEIGHT + 1, [DEPOSIT]),
      ...emptyConnects(START_HEIGHT + 2, N - 1),
    ]);
    expect(recordOf(credited.state).state).toBe('CREDITED');

    let state = credited.state;
    const alerts: TrackerEvent[] = [];
    for (let height = state.tipHeight; height > START_HEIGHT; height -= 1) {
      const transition = applyChainEvent(state, {
        kind: 'disconnect',
        height,
        blockHash: `hash-${String(height)}`,
      });
      state = transition.state;
      alerts.push(...transition.events);
    }
    const record = recordOf(state);
    expect(record.state).toBe('CREDITED'); // sticky
    expect(record.creditedAtHeight).toBe(START_HEIGHT + N);
    expect(alerts).toEqual([
      { kind: 'finality-violation', outpoint: DEPOSIT.outpoint, atHeight: START_HEIGHT + 1 },
    ]);
  });

  it('CONFLICTED is terminal and never credited', () => {
    const conflicted = run(newTracker(), [
      { kind: 'mempool', deposit: DEPOSIT },
      { kind: 'conflict', outpoint: DEPOSIT.outpoint, byTxid: 'b'.repeat(64) },
      ...emptyConnects(START_HEIGHT + 1, N + 2),
    ]);
    expect(recordOf(conflicted.state).state).toBe('CONFLICTED');
    expect(conflicted.events).toEqual([]);

    // Even a connect carrying the outpoint does not resurrect it (M3 policy).
    const reconnected = run(conflicted.state, [
      connectAt(conflicted.state.tipHeight + 1, [DEPOSIT]),
    ]);
    expect(recordOf(reconnected.state).state).toBe('CONFLICTED');
    expect(reconnected.events).toEqual([]);
  });

  it('malformed sequences throw instead of corrupting accounting', () => {
    const base = newTracker();
    expect(() => applyChainEvent(base, connectAt(START_HEIGHT + 2))).toThrow(ChainEventError);
    expect(() =>
      applyChainEvent(base, { kind: 'disconnect', height: START_HEIGHT - 1, blockHash: 'x' }),
    ).toThrow(ChainEventError);
    expect(() => initialTrackerState(0, START_HEIGHT)).toThrow(ChainEventError);
  });

  it('rejects corrupted snapshots that decouple the credit latch', () => {
    const credited = run(newTracker(), [
      connectAt(START_HEIGHT + 1, [DEPOSIT]),
      ...emptyConnects(START_HEIGHT + 2, N - 1),
    ]);
    const snapshot = snapshotTrackerState(credited.state);
    const record = snapshot.records[0];
    expect(record).toBeDefined();
    if (record === undefined) {
      return;
    }

    // CONFIRMING with a latched credit height: the double-credit vector.
    expect(() =>
      restoreTrackerState({
        ...snapshot,
        records: [{ ...record, state: 'CONFIRMING' }],
      }),
    ).toThrow(ChainEventError);

    // CREDITED with no latch is equally inconsistent.
    expect(() =>
      restoreTrackerState({
        ...snapshot,
        records: [{ ...record, creditedAtHeight: null }],
      }),
    ).toThrow(ChainEventError);

    // CONFIRMING without inclusion, and inclusion above the tip.
    expect(() =>
      restoreTrackerState({
        ...snapshot,
        records: [{ ...record, state: 'CONFIRMING', creditedAtHeight: null, inclusion: null }],
      }),
    ).toThrow(ChainEventError);
    expect(() =>
      restoreTrackerState({
        ...snapshot,
        tipHeight: (record.inclusion?.height ?? 0) - 1,
      }),
    ).toThrow(ChainEventError);
  });

  it('a restored credited record never re-credits as the chain extends', () => {
    const credited = run(newTracker(), [
      connectAt(START_HEIGHT + 1, [DEPOSIT]),
      ...emptyConnects(START_HEIGHT + 2, N - 1),
    ]);
    const restored = restoreTrackerState(snapshotTrackerState(credited.state));
    const extended = run(restored, emptyConnects(restored.tipHeight + 1, 3));
    expect(extended.events).toEqual([]); // the latch survives restore
    expect(recordOf(extended.state).creditedAtHeight).toBe(START_HEIGHT + N);
  });

  it('snapshot/restore round-trips exactly, bigint sats included', () => {
    const populated = run(newTracker(), [
      { kind: 'mempool', deposit: DEPOSIT },
      connectAt(START_HEIGHT + 1, [DEPOSIT]),
    ]);
    const restored = restoreTrackerState(snapshotTrackerState(populated.state));
    expect(restored.tipHeight).toBe(populated.state.tipHeight);
    expect(restored.finalityDepth).toBe(populated.state.finalityDepth);
    expect([...restored.records.entries()]).toEqual([...populated.state.records.entries()]);
    expect(recordOf(restored).amountSats).toBe(12_345_678n);
  });
});
