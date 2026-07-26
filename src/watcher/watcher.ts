/**
 * The block-walking chain watcher (M3): polls the node explicitly — no
 * timers, no ZMQ push — and turns what it sees into ordered chain events
 * for the pure confirmation state machine (src/core/confirmations.ts,
 * ADR-0002).
 *
 * One `poll()` pass:
 *   1. scan the mempool for new deposits to watched addresses;
 *   2. read the best block hash; if unchanged, done;
 *   3. otherwise walk headers tip→backwards to the fork point against the
 *      processed-chain map (bounded), disconnect the orphaned blocks
 *      descending, then connect the new blocks ascending.
 *
 * The watcher is deterministic from the chain it is shown: tests drive the
 * chain, then call poll(). Checkpointing (CF-04) captures tracker state
 * plus the processed-chain map, so a restarted watcher re-emits nothing.
 */

import {
  applyChainEvent,
  initialTrackerState,
  restoreTrackerState,
  snapshotTrackerState,
  type ChainEvent,
  type TrackerEvent,
  type TrackerSnapshot,
  type TrackerState,
  type WatchedDeposit,
} from '../core/confirmations.js';
import type { BitcoindRpc } from '../rpc/bitcoind.js';

export class WatcherError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'WatcherError';
  }
}

export interface WatcherCheckpoint {
  readonly tracker: TrackerSnapshot;
  readonly processedChain: readonly { readonly height: number; readonly hash: string }[];
  readonly seenMempoolTxids: readonly string[];
  /** Inputs of every watched deposit transaction — the conflict index (RG-03). */
  readonly depositInputs: readonly {
    readonly txid: string;
    readonly inputs: readonly { readonly txid: string; readonly vout: number }[];
  }[];
}

/** Processed-chain entries kept below the tip (bounds checkpoint size). */
const PROCESSED_RETENTION = 200;
/**
 * Deepest reorg a single poll will walk before failing loudly — equal to
 * the retention window on purpose: anything deeper could not be
 * disconnected anyway, so the two bounds must agree on the watcher's
 * supported depth.
 */
const MAX_WALK_DEPTH = PROCESSED_RETENTION;

export class ChainWatcher {
  private trackerState: TrackerState;
  private readonly processed = new Map<number, string>();
  private readonly seenMempoolTxids = new Set<string>();
  /** deposit txid → inputs it spends. */
  private readonly depositInputs = new Map<string, readonly { txid: string; vout: number }[]>();
  /** spent-input key → deposit txids spending it (conflict detection). */
  private readonly inputSpenders = new Map<string, Set<string>>();

  private constructor(
    private readonly node: BitcoindRpc,
    private readonly watched: ReadonlySet<string>,
    trackerState: TrackerState,
  ) {
    this.trackerState = trackerState;
  }

  /** Starts watching at the node's current tip: earlier history is out of scope by design. */
  static async create(
    node: BitcoindRpc,
    watched: ReadonlySet<string>,
    finalityDepth: number,
  ): Promise<ChainWatcher> {
    const tipHash = await node.getBestBlockHash();
    const tipHeader = await node.getBlockHeader(tipHash);
    const watcher = new ChainWatcher(
      node,
      watched,
      initialTrackerState(finalityDepth, tipHeader.height),
    );
    watcher.processed.set(tipHeader.height, tipHash);
    return watcher;
  }

  static fromCheckpoint(
    node: BitcoindRpc,
    watched: ReadonlySet<string>,
    checkpoint: WatcherCheckpoint,
  ): ChainWatcher {
    const watcher = new ChainWatcher(node, watched, restoreTrackerState(checkpoint.tracker));
    for (const { height, hash } of checkpoint.processedChain) {
      watcher.processed.set(height, hash);
    }
    for (const txid of checkpoint.seenMempoolTxids) {
      watcher.seenMempoolTxids.add(txid);
    }
    for (const { txid, inputs } of checkpoint.depositInputs) {
      watcher.indexDepositInputs(txid, inputs);
    }
    return watcher;
  }

  get state(): TrackerState {
    return this.trackerState;
  }

  checkpoint(): WatcherCheckpoint {
    return {
      tracker: snapshotTrackerState(this.trackerState),
      processedChain: [...this.processed.entries()]
        .map(([height, hash]) => ({ height, hash }))
        .sort((a, b) => a.height - b.height),
      seenMempoolTxids: [...this.seenMempoolTxids].sort(),
      depositInputs: [...this.depositInputs.entries()]
        .map(([txid, inputs]) => ({ txid, inputs }))
        .sort((a, b) => a.txid.localeCompare(b.txid)),
    };
  }

  private static inputKey(input: { txid: string; vout: number }): string {
    return `${input.txid}:${String(input.vout)}`;
  }

  private indexDepositInputs(
    depositTxid: string,
    inputs: readonly { txid: string; vout: number }[],
  ): void {
    if (this.depositInputs.has(depositTxid)) {
      return;
    }
    this.depositInputs.set(depositTxid, inputs);
    for (const input of inputs) {
      const key = ChainWatcher.inputKey(input);
      const spenders = this.inputSpenders.get(key) ?? new Set<string>();
      spenders.add(depositTxid);
      this.inputSpenders.set(key, spenders);
    }
  }

  /** Deposit txids whose inputs `tx` double-spends (excluding itself). */
  private conflictingDeposits(
    txid: string,
    inputs: readonly { readonly txid: string; readonly vout: number }[],
  ): Set<string> {
    const conflicted = new Set<string>();
    for (const input of inputs) {
      const spenders = this.inputSpenders.get(ChainWatcher.inputKey(input));
      if (spenders !== undefined) {
        for (const spender of spenders) {
          if (spender !== txid) {
            conflicted.add(spender);
          }
        }
      }
    }
    return conflicted;
  }

  /** One bounded polling pass; returns the tracker events it caused. */
  async poll(): Promise<TrackerEvent[]> {
    const events: TrackerEvent[] = [];
    await this.scanMempool(events);
    await this.walkChain(events);
    return events;
  }

  private apply(event: ChainEvent, into: TrackerEvent[]): void {
    const transition = applyChainEvent(this.trackerState, event);
    this.trackerState = transition.state;
    into.push(...transition.events);
  }

  private async scanMempool(into: TrackerEvent[]): Promise<void> {
    const mempool = await this.node.getRawMempool();
    for (const txid of mempool) {
      if (this.seenMempoolTxids.has(txid)) {
        continue;
      }
      this.seenMempoolTxids.add(txid);
      const deposits = await this.depositsOfTransaction(txid);
      if (deposits.length > 0) {
        this.indexDepositInputs(txid, await this.node.getRawTransactionInputs(txid));
      }
      for (const deposit of deposits) {
        this.apply({ kind: 'mempool', deposit }, into);
      }
    }
  }

  private async depositsOfTransaction(txid: string): Promise<WatchedDeposit[]> {
    const outputs = await this.node.getRawTransactionOutputs(txid);
    return outputs
      .filter((output) => output.address !== null && this.watched.has(output.address))
      .map((output) => ({
        outpoint: { txid, vout: output.vout },
        address: output.address ?? '',
        amountSats: output.valueSats,
      }));
  }

  private topProcessedHash(): string {
    const hash = this.processed.get(this.trackerState.tipHeight);
    if (hash === undefined) {
      throw new WatcherError(`no processed hash at tip ${String(this.trackerState.tipHeight)}`);
    }
    return hash;
  }

  private async walkChain(into: TrackerEvent[]): Promise<void> {
    const tipHash = await this.node.getBestBlockHash();
    if (tipHash === this.topProcessedHash()) {
      return;
    }

    // Walk tip→backwards until we land on a block we already processed.
    const newChain: { height: number; hash: string }[] = [];
    let cursor = tipHash;
    let forkHeight: number | null = null;
    for (let steps = 0; steps <= MAX_WALK_DEPTH; steps += 1) {
      const header = await this.node.getBlockHeader(cursor);
      if (this.processed.get(header.height) === cursor) {
        forkHeight = header.height;
        break;
      }
      newChain.push({ height: header.height, hash: cursor });
      if (header.previousBlockHash === null) {
        forkHeight = header.height - 1; // walked to genesis
        break;
      }
      cursor = header.previousBlockHash;
    }
    if (forkHeight === null) {
      throw new WatcherError(
        `no fork point within ${String(MAX_WALK_DEPTH)} blocks — reorg deeper than the walk budget`,
      );
    }

    // Disconnect orphaned blocks, tip first.
    for (let height = this.trackerState.tipHeight; height > forkHeight; height -= 1) {
      const hash = this.processed.get(height);
      if (hash === undefined) {
        throw new WatcherError(`cannot disconnect unprocessed height ${String(height)}`);
      }
      this.apply({ kind: 'disconnect', height, blockHash: hash }, into);
      this.processed.delete(height);
    }

    // Connect the new chain, ascending; conflicts surface after each block.
    for (const { height, hash } of [...newChain].reverse()) {
      const block = await this.node.getBlockWithTransactions(hash);
      const deposits: WatchedDeposit[] = [];
      const conflicts: { depositTxid: string; byTxid: string }[] = [];
      for (const transaction of block.transactions) {
        let carriesDeposit = false;
        for (const output of transaction.outputs) {
          if (output.address !== null && this.watched.has(output.address)) {
            carriesDeposit = true;
            deposits.push({
              outpoint: { txid: transaction.txid, vout: output.vout },
              address: output.address,
              amountSats: output.valueSats,
            });
          }
        }
        if (carriesDeposit) {
          this.indexDepositInputs(transaction.txid, transaction.inputs);
        }
        for (const depositTxid of this.conflictingDeposits(transaction.txid, transaction.inputs)) {
          conflicts.push({ depositTxid, byTxid: transaction.txid });
        }
      }
      this.apply({ kind: 'connect', height, blockHash: hash, deposits }, into);
      // A mined double-spend of a watched deposit's input is the one way a
      // deposit dies for good (RG-03) — surfaced after the block connects.
      for (const conflict of conflicts) {
        for (const record of this.trackerState.records.values()) {
          if (record.outpoint.txid === conflict.depositTxid) {
            this.apply(
              { kind: 'conflict', outpoint: record.outpoint, byTxid: conflict.byTxid },
              into,
            );
          }
        }
      }
      this.processed.set(height, hash);
      this.processed.delete(height - PROCESSED_RETENTION);
    }
  }
}
