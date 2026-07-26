/**
 * Broadcast accounting (M6, BR-01…BR-03): classify `sendrawtransaction`
 * outcomes into typed results and fold them into a withdrawal record whose
 * transitions make retry storms free and conflicts terminal.
 *
 * The stance mirrors ADR-0002's confirmation machine: rebroadcast of an
 * in-flight withdrawal never mutates the record (BR-01); the node saying
 * "already mined" is a terminal success for the BROADCAST concern and
 * leaves the record untouched — crediting belongs to the confirmation
 * tracker, not here (BR-02); a conflict rejection moves the record to a
 * terminal `failed` state, never a stuck in-flight one (BR-03). Outcomes
 * that contradict the record's state throw rather than corrupt.
 *
 * Error-code → outcome mapping is a characterization contract [pin: M6]:
 * the BR integration specs pin the exact codes and messages Core 31.1
 * actually emits, and this module is written against those pins.
 */

/** The raw result of one `sendrawtransaction` attempt, RPC-shape agnostic. */
export type BroadcastAttemptResult =
  | { readonly kind: 'sent'; readonly txid: string }
  | { readonly kind: 'rpc-error'; readonly code: number; readonly message: string };

export type BroadcastOutcome =
  /** Node accepted (fresh, or already in its mempool — indistinguishable). */
  | { readonly kind: 'accepted' }
  /** RPC -27: every output already exists in the UTXO set — the tx is mined. */
  | { readonly kind: 'already-mined' }
  /** RPC -25/-26: an input is spent or being spent by a conflicting tx. */
  | { readonly kind: 'rejected-conflict'; readonly reason: string };

/** RPC_VERIFY_ALREADY_IN_CHAIN: the transaction is already mined. */
const RPC_TRANSACTION_ALREADY_IN_CHAIN = -27;
/** RPC_TRANSACTION_ERROR: inputs missing or already spent on-chain. */
const RPC_TRANSACTION_ERROR = -25;
/** RPC_TRANSACTION_REJECTED: mempool policy rejection (e.g. losing an RBF race). */
const RPC_TRANSACTION_REJECTED = -26;

/**
 * An RPC error this module refuses to guess about (transport trouble, bad
 * hex, unknown policy failure). Callers surface it and retry or alert —
 * silently classifying it would fabricate accounting.
 */
export class UnclassifiedBroadcastError extends Error {
  constructor(
    readonly code: number,
    readonly rpcMessage: string,
  ) {
    super(`unclassified broadcast rejection ${String(code)}: ${rpcMessage}`);
    this.name = 'UnclassifiedBroadcastError';
  }
}

/** A success or conflict outcome that contradicts the record it is applied to. */
export class BroadcastStateError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'BroadcastStateError';
  }
}

/**
 * Map one attempt's raw result to a typed outcome. The expected txid guards
 * the impossible-by-construction case of the node returning a different
 * txid for our hex — that is harness corruption, not an outcome.
 */
export function classifyBroadcastResult(
  result: BroadcastAttemptResult,
  expectedTxid: string,
): BroadcastOutcome {
  if (result.kind === 'sent') {
    if (result.txid !== expectedTxid) {
      throw new BroadcastStateError(
        `node returned txid ${result.txid} for a broadcast of ${expectedTxid}`,
      );
    }
    return { kind: 'accepted' };
  }
  if (result.code === RPC_TRANSACTION_ALREADY_IN_CHAIN) {
    return { kind: 'already-mined' };
  }
  if (result.code === RPC_TRANSACTION_ERROR || result.code === RPC_TRANSACTION_REJECTED) {
    return { kind: 'rejected-conflict', reason: result.message };
  }
  throw new UnclassifiedBroadcastError(result.code, result.message);
}

export type WithdrawalState = 'in-flight' | 'failed';

export interface WithdrawalRecord {
  readonly txid: string;
  readonly state: WithdrawalState;
  /** Populated exactly when state is `failed`. */
  readonly failureReason: string | null;
}

/** A withdrawal enters the ledger in-flight the moment broadcast is intended. */
export function initialWithdrawal(txid: string): WithdrawalRecord {
  return { txid, state: 'in-flight', failureReason: null };
}

/**
 * Fold one broadcast outcome into the record. Repeated application of the
 * same outcome is always a no-op — retries are free by construction, which
 * is the invariant BR-01/BR-02 hold against the live node.
 */
export function applyBroadcastOutcome(
  record: WithdrawalRecord,
  outcome: BroadcastOutcome,
): WithdrawalRecord {
  if (record.state === 'failed') {
    if (outcome.kind === 'rejected-conflict') {
      return record; // terminal; repeat rejections change nothing
    }
    throw new BroadcastStateError(
      `${outcome.kind} outcome for ${record.txid} contradicts its terminal failed state`,
    );
  }
  switch (outcome.kind) {
    case 'accepted':
    case 'already-mined':
      // In-flight it stays: crediting is the confirmation tracker's job.
      return record;
    case 'rejected-conflict':
      return { txid: record.txid, state: 'failed', failureReason: outcome.reason };
  }
}
