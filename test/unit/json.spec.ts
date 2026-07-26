/**
 * Unit — number-preserving JSON parser (ADR-0004).
 *
 * Chain events driven: none (pure).
 * Invariant: structure and strings match JSON.parse exactly; every number
 *   surfaces with its untouched decimal source text — no double round-trip.
 * Custody risk: bitcoind amounts passing through IEEE-754 doubles drift by
 *   a satoshi and the drift compounds silently.
 * Falsification lever: FALSIFY=JSON (harness lands M2) routes numbers
 *   through Number(); the 0.1-preservation case goes red.
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { JsonParseError, parseJson, RawNumber, type JsonValue } from '../../src/rpc/json.js';

function rehydrate(value: JsonValue): unknown {
  if (value instanceof RawNumber) {
    return Number(value.text);
  }
  if (Array.isArray(value)) {
    return value.map(rehydrate);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rehydrate(entry)]));
  }
  return value;
}

describe('parseJson', () => {
  it('preserves number source text exactly', () => {
    const parsed = parseJson('{"amount":0.1,"fee":-0.00001000,"subsidy":50.00000000,"height":101}');
    expect(parsed).toEqual({
      amount: new RawNumber('0.1'),
      fee: new RawNumber('-0.00001000'),
      subsidy: new RawNumber('50.00000000'),
      height: new RawNumber('101'),
    });
  });

  it('parses structures, escapes, and literals like JSON.parse', () => {
    const text = '{"a":[1,[],{},"\\u0041\\n\\"\\\\"],"b":null,"c":true,"d":false,"e":""}';
    expect(rehydrate(parseJson(text))).toEqual(JSON.parse(text));
  });

  it('rejects malformed input', () => {
    const malformed = [
      '',
      '{',
      '[1,]',
      '{"a"}',
      '{"a":1,}',
      '01',
      '1 2',
      '-',
      '"unterminated',
      '"bad \\x escape"',
      "'single'",
      '{"a":\u00011}', // control character where a value belongs
    ];
    for (const input of malformed) {
      expect(() => parseJson(input), JSON.stringify(input)).toThrow(JsonParseError);
    }
  });

  it('does not let response keys pollute prototypes', () => {
    const parsed = parseJson('{"__proto__":{"polluted":true}}');
    expect({} as { polluted?: boolean }).not.toHaveProperty('polluted');
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it('matches JSON.parse on arbitrary documents (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (document) => {
        const text = JSON.stringify(document);
        expect(rehydrate(parseJson(text))).toEqual(JSON.parse(text));
      }),
    );
  });
});
