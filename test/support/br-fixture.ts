/**
 * Shared BR plumbing: one `sendrawtransaction` attempt mapped to the
 * RPC-shape-agnostic result the broadcast classifier consumes. Transport
 * failures stay exceptions — only a node VERDICT is a result.
 */

import type { BroadcastAttemptResult } from '../../src/core/broadcast.js';
import type { BitcoindRpc } from '../../src/rpc/bitcoind.js';
import { RpcError } from '../../src/rpc/client.js';

export async function attemptBroadcast(
  node: BitcoindRpc,
  hex: string,
): Promise<BroadcastAttemptResult> {
  try {
    return { kind: 'sent', txid: await node.sendRawTransaction(hex) };
  } catch (error) {
    if (error instanceof RpcError) {
      return { kind: 'rpc-error', code: error.code, message: error.rpcMessage };
    }
    throw error;
  }
}
