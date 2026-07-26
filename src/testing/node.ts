/**
 * Regtest fixtures: connection, readiness gate, ephemeral node-side signing
 * wallet, mining helpers. The signing wallet lives only inside the
 * disposable container — the library never sees a private key (hard
 * limit 2). Chain state dies with the container, so every CI run starts
 * from genesis; create-or-load keeps local re-runs against a still-warm
 * stack idempotent.
 */

import { BitcoindRpc } from '../rpc/bitcoind.js';
import { JsonRpcClient, RpcError, RpcTransportError } from '../rpc/client.js';
import { regtestConnectionFromEnv } from './env.js';
import { pollUntil, type PollBudget } from './poll.js';

/**
 * Consensus coinbase maturity. The mempool checks it against the NEXT block,
 * so a coinbase spend is accepted at depth 100 and first confirms at depth
 * 101 — boundary pinned by the M1 characterization test.
 */
export const COINBASE_MATURITY = 100;

export function connectRegtest(): BitcoindRpc {
  return new BitcoindRpc(new JsonRpcClient(regtestConnectionFromEnv()));
}

const READY_BUDGET: PollBudget = { attempts: 30, delayMs: 1000 };

/** bitcoind answers RPC with this code (over HTTP 500) while starting up. */
const RPC_IN_WARMUP = -28;

/** Gate: node reachable AND the chain is regtest — any other network is refused (hard limit 3). */
export async function awaitRegtestReady(node: BitcoindRpc): Promise<void> {
  const info = await pollUntil(
    'bitcoind readiness — is the stack up? (npm run stack:up)',
    READY_BUDGET,
    async () => {
      try {
        return await node.getBlockchainInfo();
      } catch (error) {
        if (
          error instanceof RpcTransportError ||
          (error instanceof RpcError && error.code === RPC_IN_WARMUP)
        ) {
          return undefined;
        }
        throw error;
      }
    },
  );
  if (info.chain !== 'regtest') {
    throw new Error(`refusing to run against chain "${info.chain}" — regtest only (hard limit 3)`);
  }
}

export const SIGNING_WALLET = 'bct-signing';

/** RPC_WALLET_ERROR: createwallet on a name that already exists on disk. */
const WALLET_EXISTS_CODE = -4;

export async function openSigningWallet(node: BitcoindRpc): Promise<BitcoindRpc> {
  const loaded = await node.listWallets();
  if (!loaded.includes(SIGNING_WALLET)) {
    try {
      await node.createWallet(SIGNING_WALLET);
    } catch (error) {
      if (error instanceof RpcError && error.code === WALLET_EXISTS_CODE) {
        await node.loadWallet(SIGNING_WALLET);
      } else {
        throw error;
      }
    }
  }
  return node.forWallet(SIGNING_WALLET);
}

/** Mines `blocks` new blocks paying a fresh address of `wallet`; returns the block hashes. */
export async function mineToWallet(
  node: BitcoindRpc,
  wallet: BitcoindRpc,
  blocks: number,
): Promise<string[]> {
  const address = await wallet.getNewAddress();
  return node.generateToAddress(blocks, address);
}
