/**
 * Connection defaults matching docker-compose.yml's fixed test-only rpcauth.
 * Determinism over secrecy: this credential only ever guards a disposable
 * regtest node — no real funds exist anywhere in this system (hard limit 3).
 */

import type { RpcConnection } from '../rpc/client.js';

export function regtestConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): RpcConnection {
  return {
    url: env['BITCOIND_RPC_URL'] ?? 'http://127.0.0.1:18443',
    username: env['BITCOIND_RPC_USER'] ?? 'bct',
    password: env['BITCOIND_RPC_PASSWORD'] ?? 'regtest-test-only-not-a-secret',
  };
}
