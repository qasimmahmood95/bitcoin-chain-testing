/**
 * Minimal typed JSON-RPC client for bitcoind — transport only: HTTP POST,
 * basic auth, envelope interpretation. Responses are parsed with the
 * number-preserving parser so amounts never pass through doubles
 * (ADR-0004). No retries, no pooling: scenarios own their polling budgets.
 */

import { parseJson, type JsonValue } from './json.js';
import { asInteger, asObject, asString } from './decode.js';

export interface RpcConnection {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

/** bitcoind processed the call and rejected it (JSON-RPC error object). */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    readonly rpcMessage: string,
    readonly method: string,
  ) {
    super(`${method}: RPC error ${String(code)}: ${rpcMessage}`);
    this.name = 'RpcError';
  }
}

/** The HTTP exchange itself failed: unreachable, bad auth, non-JSON body. */
export class RpcTransportError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(detail, options);
    this.name = 'RpcTransportError';
  }
}

/**
 * Pure interpretation of a JSON-RPC response body — separated from the HTTP
 * exchange so the error-envelope contract is unit-testable against recorded
 * payloads without any node.
 */
export function interpretRpcResponseBody(body: string, method: string): JsonValue {
  let parsed: JsonValue;
  try {
    parsed = parseJson(body);
  } catch (cause) {
    throw new RpcTransportError(`${method}: response is not JSON`, { cause });
  }
  const envelope = asObject(parsed, `${method} response`);
  const error = envelope['error'];
  if (error !== undefined && error !== null) {
    const errorObject = asObject(error, `${method} error`);
    throw new RpcError(
      asInteger(errorObject['code'], `${method} error.code`),
      asString(errorObject['message'], `${method} error.message`),
      method,
    );
  }
  const result = envelope['result'];
  if (result === undefined) {
    throw new RpcTransportError(`${method}: response carries neither result nor error`);
  }
  return result;
}

export class JsonRpcClient {
  constructor(
    private readonly connection: RpcConnection,
    private readonly path: string = '/',
  ) {}

  /** Same connection, scoped to a wallet endpoint (`/wallet/<name>`). */
  forWallet(walletName: string): JsonRpcClient {
    return new JsonRpcClient(this.connection, `/wallet/${walletName}`);
  }

  async call(method: string, params: readonly unknown[] = []): Promise<JsonValue> {
    const { url, username, password } = this.connection;
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    let response: Response;
    try {
      response = await fetch(new URL(this.path, url), {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '1.0', id: 'bitcoin-chain-testing', method, params }),
      });
    } catch (cause) {
      throw new RpcTransportError(`${method}: bitcoind unreachable at ${url}`, { cause });
    }
    const body = await response.text();
    if (!response.ok && body.trim() === '') {
      throw new RpcTransportError(
        `${method}: HTTP ${String(response.status)} with empty body (bad credentials?)`,
      );
    }
    return interpretRpcResponseBody(body, method);
  }
}
