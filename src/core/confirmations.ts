/**
 * The confirmation-depth state machine (M3, ADR-0002).
 *
 * Pure and event-driven: chain events in, deposit records and tracker
 * events out. No I/O, no RPC imports — the block-walking watcher
 * (src/watcher/) feeds it live events, the fast-check model (CF-03)
 * feeds it generated ones, and both must agree with an oracle
 * recomputation from full history.
 *
 * Policies (ADR-0002):
 * - Credit exactly once, at confirmations ≥ N (`tip − inclusionHeight + 1`),
 *   latched by `creditedAtHeight`.
 * - Credit is sticky: a disconnect that reaches a credited deposit raises
 *   FINALITY_VIOLATION and leaves the credit untouched — alert, never a
 *   silent clawback.
 * - A disconnected uncredited deposit reverts to SEEN_MEMPOOL (disconnected
 *   transactions re-enter the mempool when still valid — "reorged out" ≠
 *   "gone"; the deposit only dies via a conflicting spend, RG-03).
 * - CONFLICTED is terminal and never credited.
 * - Malformed event sequences (connect at the wrong height, disconnect of a
 *   non-tip block) throw ChainEventError: a corrupt feed must crash loudly,
 *   never corrupt accounting.
 */

export interface Outpoint {
  readonly txid: string;
  readonly vout: number;
}

export function outpointKey(outpoint: Outpoint): string {
  return `${outpoint.txid}:${String(outpoint.vout)}`;
}

export interface WatchedDeposit {
  readonly outpoint: Outpoint;
  readonly address: string;
  readonly amountSats: bigint;
}

export type DepositStateKind = 'SEEN_MEMPOOL' | 'CONFIRMING' | 'CREDITED' | 'CONFLICTED';

export interface BlockRef {
  readonly height: number;
  readonly blockHash: string;
}

export interface DepositRecord {
  readonly outpoint: Outpoint;
  readonly address: string;
  readonly amountSats: bigint;
  readonly inclusion: BlockRef | null;
  readonly state: DepositStateKind;
  /** Height at which credit latched — null until credited, immutable after. */
  readonly creditedAtHeight: number | null;
}

export type ChainEvent =
  | { readonly kind: 'mempool'; readonly deposit: WatchedDeposit }
  | {
      readonly kind: 'connect';
      readonly height: number;
      readonly blockHash: string;
      readonly deposits: readonly WatchedDeposit[];
    }
  | { readonly kind: 'disconnect'; readonly height: number; readonly blockHash: string }
  | { readonly kind: 'conflict'; readonly outpoint: Outpoint; readonly byTxid: string };

export type TrackerEvent =
  | { readonly kind: 'credited'; readonly outpoint: Outpoint; readonly atHeight: number }
  | {
      readonly kind: 'finality-violation';
      readonly outpoint: Outpoint;
      readonly atHeight: number;
    };

export interface TrackerState {
  readonly finalityDepth: number;
  readonly tipHeight: number;
  readonly records: ReadonlyMap<string, DepositRecord>;
}

export class ChainEventError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ChainEventError';
  }
}

export function initialTrackerState(finalityDepth: number, tipHeight: number): TrackerState {
  if (!Number.isInteger(finalityDepth) || finalityDepth < 1) {
    throw new ChainEventError(
      `finality depth must be a positive integer: ${String(finalityDepth)}`,
    );
  }
  return { finalityDepth, tipHeight, records: new Map() };
}

/** Confirmations of a record against a tip: `tip − inclusionHeight + 1`; 0 while unconfirmed. */
export function confirmationsOf(record: DepositRecord, tipHeight: number): number {
  return record.inclusion === null ? 0 : tipHeight - record.inclusion.height + 1;
}

export interface TrackerTransition {
  readonly state: TrackerState;
  readonly events: readonly TrackerEvent[];
}

export function applyChainEvent(state: TrackerState, event: ChainEvent): TrackerTransition {
  switch (event.kind) {
    case 'mempool':
      return applyMempool(state, event.deposit);
    case 'connect':
      return applyConnect(state, event.height, event.blockHash, event.deposits);
    case 'disconnect':
      return applyDisconnect(state, event.height, event.blockHash);
    case 'conflict':
      return applyConflict(state, event.outpoint);
  }
}

function applyMempool(state: TrackerState, deposit: WatchedDeposit): TrackerTransition {
  const key = outpointKey(deposit.outpoint);
  // The watcher already dedups mempool sightings by txid before it feeds
  // us, so a second check here is redundant work on every poll.
  const records = new Map(state.records);
  records.set(key, {
    outpoint: deposit.outpoint,
    address: deposit.address,
    amountSats: deposit.amountSats,
    inclusion: null,
    state: 'SEEN_MEMPOOL',
    creditedAtHeight: null,
  });
  return { state: { ...state, records }, events: [] };
}

function applyConnect(
  state: TrackerState,
  height: number,
  blockHash: string,
  deposits: readonly WatchedDeposit[],
): TrackerTransition {
  if (height !== state.tipHeight + 1) {
    throw new ChainEventError(
      `connect at height ${String(height)} but tip is ${String(state.tipHeight)}`,
    );
  }
  const records = new Map(state.records);
  for (const deposit of deposits) {
    const key = outpointKey(deposit.outpoint);
    const existing = records.get(key);
    if (existing?.state === 'CONFLICTED') {
      // Terminal by policy (ADR-0002): once conflicted, a re-appearing
      // outpoint is absorbed — never silently resurrected into credit.
      continue;
    }
    if (existing === undefined) {
      records.set(key, {
        outpoint: deposit.outpoint,
        address: deposit.address,
        amountSats: deposit.amountSats,
        inclusion: { height, blockHash },
        state: 'CONFIRMING',
        creditedAtHeight: null,
      });
    } else {
      records.set(key, {
        ...existing,
        inclusion: { height, blockHash },
        state: existing.state === 'CREDITED' ? 'CREDITED' : 'CONFIRMING',
      });
    }
  }

  // Credit pass: everything included and mature at the new tip credits
  // exactly once (creditedAtHeight latch).
  const events: TrackerEvent[] = [];
  for (const [key, record] of records) {
    if (
      record.state === 'CONFIRMING' &&
      record.creditedAtHeight === null &&
      confirmationsOf(record, height) >= state.finalityDepth
    ) {
      records.set(key, { ...record, state: 'CREDITED', creditedAtHeight: height });
      events.push({ kind: 'credited', outpoint: record.outpoint, atHeight: height });
    }
  }
  return { state: { ...state, tipHeight: height, records }, events };
}

function applyDisconnect(
  state: TrackerState,
  height: number,
  blockHash: string,
): TrackerTransition {
  if (height !== state.tipHeight) {
    throw new ChainEventError(
      `disconnect of height ${String(height)} but tip is ${String(state.tipHeight)}`,
    );
  }
  const records = new Map(state.records);
  const events: TrackerEvent[] = [];
  for (const [key, record] of records) {
    if (record.inclusion === null || record.inclusion.height !== height) {
      continue;
    }
    if (record.inclusion.blockHash !== blockHash) {
      throw new ChainEventError(
        `disconnect hash ${blockHash} does not match inclusion ${record.inclusion.blockHash} at height ${String(height)}`,
      );
    }
    if (record.state === 'CREDITED') {
      // Sticky credit: alert, never a silent clawback (ADR-0002).
      records.set(key, { ...record, inclusion: null });
      events.push({ kind: 'finality-violation', outpoint: record.outpoint, atHeight: height });
    } else {
      // Mempool resurrection default: demoted, not gone.
      records.set(key, { ...record, inclusion: null, state: 'SEEN_MEMPOOL' });
    }
  }
  return { state: { ...state, tipHeight: height - 1, records }, events };
}

function applyConflict(state: TrackerState, outpoint: Outpoint): TrackerTransition {
  const key = outpointKey(outpoint);
  const record = state.records.get(key);
  if (record === undefined) {
    return { state, events: [] };
  }
  const records = new Map(state.records);
  if (record.state === 'CREDITED') {
    // Credited balances never silently change — alert instead (ADR-0002).
    return {
      state,
      events: [
        { kind: 'finality-violation', outpoint: record.outpoint, atHeight: state.tipHeight },
      ],
    };
  }
  records.set(key, { ...record, inclusion: null, state: 'CONFLICTED' });
  return { state: { ...state, records }, events: [] };
}

// ── Checkpointing (CF-04) ────────────────────────────────────────────────

interface SnapshotRecord {
  readonly outpoint: Outpoint;
  readonly address: string;
  readonly amountSats: string;
  readonly inclusion: BlockRef | null;
  readonly state: DepositStateKind;
  readonly creditedAtHeight: number | null;
}

export interface TrackerSnapshot {
  readonly finalityDepth: number;
  readonly tipHeight: number;
  readonly records: readonly SnapshotRecord[];
}

/** JSON-safe snapshot (bigint sats as decimal strings). */
export function snapshotTrackerState(state: TrackerState): TrackerSnapshot {
  return {
    finalityDepth: state.finalityDepth,
    tipHeight: state.tipHeight,
    records: [...state.records.values()].map((record) => ({
      ...record,
      amountSats: record.amountSats.toString(),
    })),
  };
}

/**
 * Restore validates every record's internal consistency — the credited
 * latch (`creditedAtHeight`) and the state field must agree, and inclusion
 * must match the state. A corrupted checkpoint that decouples them could
 * otherwise re-credit on the next connect; corrupt input crashes loudly
 * instead of ever reaching accounting.
 */
export function restoreTrackerState(snapshot: TrackerSnapshot): TrackerState {
  const records = new Map<string, DepositRecord>();
  for (const record of snapshot.records) {
    const key = outpointKey(record.outpoint);
    const credited = record.state === 'CREDITED';
    if (credited !== (record.creditedAtHeight !== null)) {
      throw new ChainEventError(
        `corrupt snapshot: ${key} is ${record.state} with creditedAtHeight ${String(record.creditedAtHeight)}`,
      );
    }
    if (record.state === 'CONFIRMING' && record.inclusion === null) {
      throw new ChainEventError(`corrupt snapshot: ${key} is CONFIRMING without inclusion`);
    }
    if (
      (record.state === 'SEEN_MEMPOOL' || record.state === 'CONFLICTED') &&
      record.inclusion !== null
    ) {
      throw new ChainEventError(`corrupt snapshot: ${key} is ${record.state} with inclusion`);
    }
    if (record.inclusion !== null && record.inclusion.height > snapshot.tipHeight) {
      throw new ChainEventError(`corrupt snapshot: ${key} included above the tip`);
    }
    records.set(key, {
      ...record,
      amountSats: BigInt(record.amountSats),
    });
  }
  return { finalityDepth: snapshot.finalityDepth, tipHeight: snapshot.tipHeight, records };
}
