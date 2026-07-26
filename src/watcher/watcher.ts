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
    };
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
      for (const deposit of await this.depositsOfTransaction(txid)) {
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

    // Connect the new chain, ascending.
    for (const { height, hash } of [...newChain].reverse()) {
      const block = await this.node.getBlockWithTransactions(hash);
      const deposits: WatchedDeposit[] = [];
      for (const transaction of block.transactions) {
        for (const output of transaction.outputs) {
          if (output.address !== null && this.watched.has(output.address)) {
            deposits.push({
              outpoint: { txid: transaction.txid, vout: output.vout },
              address: output.address,
              amountSats: output.valueSats,
            });
          }
        }
      }
      this.apply({ kind: 'connect', height, blockHash: hash, deposits }, into);
      this.processed.set(height, hash);
      this.processed.delete(height - PROCESSED_RETENTION);
    }
  }
}
