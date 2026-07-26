/**
 * Unit — JSON-RPC envelope interpretation and typed field decoding
 * (ADR-0004), against recorded bitcoind payload shapes.
 *
 * Chain events driven: none (pure — recorded payloads, no node, no mocks of
 *   node behaviour; the live contract is pinned by the integration lane).
 * Invariant: error envelopes become typed RpcError (code preserved);
 *   amount fields decode to exact bigint satoshis; malformed shapes fail
 *   loudly instead of flowing on.
 * Custody risk: a swallowed RPC error path turns "bitcoind said no" into
 *   "looks fine" — the error-path corruption BR-03 later builds on.
 * Falsification lever: FALSIFY=ENVELOPE swallows the error path to null —
 *   "bitcoind said no" becomes "looks fine" — and the -26 case goes red.
 */

import { describe, expect, it } from 'vitest';
import { interpretRpcResponseBody, RpcError, RpcTransportError } from '../../src/rpc/client.js';
import { asInteger, asSats, DecodeError } from '../../src/rpc/decode.js';
import { parseJson, RawNumber } from '../../src/rpc/json.js';
import { falsifyActive } from '../../src/testing/falsify.js';

// FALSIFY=ENVELOPE: the catch-and-carry-on bug on the RPC error path.
const interpret = falsifyActive('ENVELOPE')
  ? (body: string, method: string): unknown => {
      try {
        return interpretRpcResponseBody(body, method);
      } catch {
        return null;
      }
    }
  : interpretRpcResponseBody;

describe('interpretRpcResponseBody', () => {
  it('returns the result on success', () => {
    const body = '{"result":{"chain":"regtest"},"error":null,"id":"bitcoin-chain-testing"}';
    expect(interpret(body, 'getblockchaininfo')).toEqual({ chain: 'regtest' });
  });

  it('turns a bitcoind error envelope into a typed RpcError', () => {
    const body =
      '{"result":null,"error":{"code":-26,"message":"bad-txns-premature-spend-of-coinbase"},"id":"bitcoin-chain-testing"}';
    let caught: unknown;
    try {
      interpret(body, 'sendrawtransaction');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RpcError);
    const rpcError = caught as RpcError;
    expect(rpcError.code).toBe(-26);
    expect(rpcError.rpcMessage).toBe('bad-txns-premature-spend-of-coinbase');
  });

  it('treats a non-JSON body as a transport failure', () => {
    expect(() => interpret('Work queue depth exceeded', 'getblockcount')).toThrow(
      RpcTransportError,
    );
  });
});

describe('typed field decoding', () => {
  it('decodes a BTC amount field to exact satoshis — the float-poison case', () => {
    const fragment = parseJson('{"value":0.1}');
    const value = (fragment as { value: RawNumber }).value;
    expect(asSats(value, 'vout.value')).toBe(10_000_000n);
  });

  it('rejects a fractional number where an integer is required', () => {
    expect(() => asInteger(new RawNumber('1.5'), 'blocks')).toThrow(DecodeError);
  });

  it('rejects exponent-notation amounts instead of coercing them', () => {
    expect(() => asSats(new RawNumber('5e-8'), 'vout.value')).toThrow(DecodeError);
  });
});
