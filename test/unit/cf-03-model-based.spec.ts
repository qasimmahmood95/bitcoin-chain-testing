/**
 * CF-03 — model-based property: the incremental tracker vs an oracle
 * recomputed from full history, over random valid chain-event sequences.
 *
 * Chain events driven: none live — a simulated chain interpreter turns
 *   fast-check-chosen operations (deposit / mine-with-subset / reorg) into
 *   valid connect/disconnect/mempool sequences.
 * Invariant: after any valid sequence, the incremental tracker's records
 *   equal a naive full-history recomputation; confirmations equal
 *   tip − inclusionHeight + 1; only legal transitions ever occur; credit
 *   is emitted at most once per outpoint.
 * Custody risk: state-machine drift under real event streams — corruption
 *   surfacing weeks later as unexplained balances.
 * Falsification lever: FALSIFY=CF-03 perturbs the oracle's confirmation
 *   count by one block; the equivalence property goes red.
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyChainEvent,
  confirmationsOf,
  initialTrackerState,
  outpointKey,
  type ChainEvent,
  type DepositRecord,
  type DepositStateKind,
  type TrackerEvent,
  type TrackerState,
  type WatchedDeposit,
} from '../../src/core/confirmations.js';
import { falsifyActive } from '../../src/testing/falsify.js';

const N = 6;
const START_HEIGHT = 50;

type Op =
  | { readonly op: 'deposit'; readonly amount: number }
  | { readonly op: 'mine'; readonly includeMask: number }
  | { readonly op: 'reorg'; readonly depth: number; readonly reincludeMask: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant('deposit' as const),
      amount: fc.integer({ min: 1, max: 1_000_000 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({ op: fc.constant('mine' as const), includeMask: fc.nat({ max: 255 }) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('reorg' as const),
      depth: fc.integer({ min: 1, max: 3 }),
      reincludeMask: fc.nat({ max: 255 }),
    }),
  },
);

interface SimBlock {
  readonly height: number;
  readonly hash: string;
  readonly deposits: readonly WatchedDeposit[];
}

/**
 * Interprets ops against a simulated chain, emitting exactly the event
 * sequence a correct watcher would: mempool sightings on broadcast,
 * connects ascending, disconnects tip-first (with disconnected deposits
 * returning to the simulated mempool — the resurrection nuance).
 */
function eventsFromOps(ops: readonly Op[]): ChainEvent[] {
  const events: ChainEvent[] = [];
  const chain: SimBlock[] = [];
  let mempool: WatchedDeposit[] = [];
  let nextTx = 0;
  let nextHashSalt = 0;
  const tip = (): number => START_HEIGHT + chain.length;

  for (const op of ops) {
    if (op.op === 'deposit') {
      const deposit: WatchedDeposit = {
        outpoint: { txid: `tx-${String(nextTx)}`, vout: 0 },
        address: 'bcrt1qwatched',
        amountSats: BigInt(op.amount),
      };
      nextTx += 1;
      mempool.push(deposit);
      events.push({ kind: 'mempool', deposit });
    } else if (op.op === 'mine') {
      const included = mempool.filter((_, i) => (op.includeMask >> (i % 8)) & 1);
      mempool = mempool.filter((deposit) => !included.includes(deposit));
      nextHashSalt += 1;
      const block: SimBlock = {
        height: tip() + 1,
        hash: `sim-${String(tip() + 1)}-${String(nextHashSalt)}`,
        deposits: included,
      };
      chain.push(block);
      events.push({
        kind: 'connect',
        height: block.height,
        blockHash: block.hash,
        deposits: block.deposits,
      });
    } else {
      const depth = Math.min(op.depth, chain.length);
      // Disconnect tip-first; disconnected deposits resurface in the mempool.
      for (let i = 0; i < depth; i += 1) {
        const block = chain.pop();
        if (block === undefined) {
          break;
        }
        events.push({ kind: 'disconnect', height: block.height, blockHash: block.hash });
        mempool.push(...block.deposits);
      }
      // Competing chain: depth+1 blocks, optionally re-including deposits.
      for (let i = 0; i <= depth; i += 1) {
        const included = i === 0 ? mempool.filter((_, j) => (op.reincludeMask >> (j % 8)) & 1) : [];
        mempool = mempool.filter((deposit) => !included.includes(deposit));
        nextHashSalt += 1;
        const block: SimBlock = {
          height: tip() + 1,
          hash: `sim-${String(tip() + 1)}-${String(nextHashSalt)}`,
          deposits: included,
        };
        chain.push(block);
        events.push({
          kind: 'connect',
          height: block.height,
          blockHash: block.hash,
          deposits: block.deposits,
        });
      }
    }
  }
  return events;
}

interface OracleRecord {
  state: DepositStateKind;
  inclusionHeight: number | null;
  creditedAtHeight: number | null;
  amountSats: bigint;
}

// FALSIFY=CF-03: the oracle's confirmation count drops the +1.
function oracleConfirmations(tip: number, inclusionHeight: number): number {
  return tip - inclusionHeight + (falsifyActive('CF-03') ? 0 : 1);
}

/**
 * Naive full-history oracle: replays the entire event list from scratch,
 * recomputing every record against the running tip on every step — no
 * incremental bookkeeping shared with the real tracker.
 */
function oracleRecords(events: readonly ChainEvent[]): Map<string, OracleRecord> {
  const records = new Map<string, OracleRecord>();
  let tip = START_HEIGHT;
  for (const event of events) {
    if (event.kind === 'mempool') {
      const key = outpointKey(event.deposit.outpoint);
      if (!records.has(key)) {
        records.set(key, {
          state: 'SEEN_MEMPOOL',
          inclusionHeight: null,
          creditedAtHeight: null,
          amountSats: event.deposit.amountSats,
        });
      }
    } else if (event.kind === 'connect') {
      tip = event.height;
      for (const deposit of event.deposits) {
        const key = outpointKey(deposit.outpoint);
        const existing = records.get(key) ?? {
          state: 'CONFIRMING' as DepositStateKind,
          inclusionHeight: null,
          creditedAtHeight: null,
          amountSats: deposit.amountSats,
        };
        if (existing.state !== 'CONFLICTED') {
          existing.inclusionHeight = event.height;
          if (existing.state !== 'CREDITED') {
            existing.state = 'CONFIRMING';
          }
        }
        records.set(key, existing);
      }
      for (const record of records.values()) {
        if (
          record.state === 'CONFIRMING' &&
          record.creditedAtHeight === null &&
          record.inclusionHeight !== null &&
          oracleConfirmations(tip, record.inclusionHeight) >= N
        ) {
          record.state = 'CREDITED';
          record.creditedAtHeight = tip;
        }
      }
    } else if (event.kind === 'disconnect') {
      tip = event.height - 1;
      for (const record of records.values()) {
        if (record.inclusionHeight === event.height) {
          record.inclusionHeight = null;
          if (record.state !== 'CREDITED') {
            record.state = 'SEEN_MEMPOOL';
          }
        }
      }
    }
  }
  return records;
}

const LEGAL_TRANSITIONS: Readonly<Record<DepositStateKind, readonly DepositStateKind[]>> = {
  SEEN_MEMPOOL: ['SEEN_MEMPOOL', 'CONFIRMING', 'CONFLICTED'],
  CONFIRMING: ['CONFIRMING', 'SEEN_MEMPOOL', 'CREDITED', 'CONFLICTED'],
  CREDITED: ['CREDITED'],
  CONFLICTED: ['CONFLICTED'],
};

describe('CF-03: model-based equivalence with a full-history oracle', () => {
  it('incremental tracker ≡ oracle recomputation over random valid sequences', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const events = eventsFromOps(ops);

        let state: TrackerState = initialTrackerState(N, START_HEIGHT);
        const emitted: TrackerEvent[] = [];
        const previousStates = new Map<string, DepositRecord>();
        for (const event of events) {
          const transition = applyChainEvent(state, event);
          // Legal transitions only, per record, per step.
          for (const [key, record] of transition.state.records) {
            const before = previousStates.get(key)?.state ?? record.state;
            expect(LEGAL_TRANSITIONS[before], `${before} → ${record.state}`).toContain(
              record.state,
            );
            previousStates.set(key, record);
          }
          state = transition.state;
          emitted.push(...transition.events);
        }

        // At most one credit per outpoint, ever.
        const creditCounts = new Map<string, number>();
        for (const event of emitted) {
          if (event.kind === 'credited') {
            const key = outpointKey(event.outpoint);
            creditCounts.set(key, (creditCounts.get(key) ?? 0) + 1);
          }
        }
        for (const [key, count] of creditCounts) {
          expect(count, `credits for ${key}`).toBe(1);
        }

        // Final equivalence with the oracle.
        const oracle = oracleRecords(events);
        expect(state.records.size).toBe(oracle.size);
        for (const [key, record] of state.records) {
          const expected = oracle.get(key);
          expect(expected, key).toBeDefined();
          if (expected === undefined) {
            continue;
          }
          expect(record.state, key).toBe(expected.state);
          expect(record.inclusion?.height ?? null, key).toBe(expected.inclusionHeight);
          expect(record.creditedAtHeight, key).toBe(expected.creditedAtHeight);
          expect(record.amountSats, key).toBe(expected.amountSats);
          // Confirmation formula pin.
          if (record.inclusion !== null) {
            expect(confirmationsOf(record, state.tipHeight)).toBe(
              state.tipHeight - record.inclusion.height + 1,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
