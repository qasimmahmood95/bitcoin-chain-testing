/**
 * Unit — exact BTC-decimal ↔ bigint-satoshi conversion (ADR-0004).
 *
 * Chain events driven: none (pure).
 * Invariant: conversion is exact and total — every valid ≤8-dp decimal maps
 *   to its unique satoshi value and back; everything else (exponents, hex,
 *   >8 dp, separators) is rejected, never coerced.
 * Custody risk: float rounding at the RPC boundary silently corrupts
 *   balances — 0.1 BTC has no IEEE-754 double representation.
 * Falsification lever: FALSIFY=AMOUNT (harness lands M2) reroutes conversion
 *   through parseFloat; the 0.1 case and the round-trip property go red.
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AmountFormatError, btcToSats, satsToBtc } from '../../src/rpc/amount.js';

describe('btcToSats', () => {
  it('converts exact decimals', () => {
    expect(btcToSats('0')).toBe(0n);
    expect(btcToSats('1')).toBe(100_000_000n);
    expect(btcToSats('0.1')).toBe(10_000_000n);
    expect(btcToSats('50.00000000')).toBe(5_000_000_000n);
    expect(btcToSats('0.00000001')).toBe(1n);
    expect(btcToSats('20999999.97690000')).toBe(2_099_999_997_690_000n);
    expect(btcToSats('-0.00500000')).toBe(-500_000n);
  });

  it('rejects everything that is not a plain ≤8-dp decimal', () => {
    const rejected = [
      '',
      ' 1',
      '1 ',
      '+1',
      '1.',
      '.5',
      '1.123456789',
      '1e8',
      '5E-8',
      '0x10',
      'NaN',
      'Infinity',
      '1,000',
      '--1',
    ];
    for (const input of rejected) {
      expect(() => btcToSats(input), JSON.stringify(input)).toThrow(AmountFormatError);
    }
  });

  it('round-trips every representable satoshi value (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -2_100_000_000_000_000n, max: 2_100_000_000_000_000n }),
        (sats) => {
          expect(btcToSats(satsToBtc(sats))).toBe(sats);
        },
      ),
    );
  });

  it('agrees with integer whole/fraction construction (property)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 20_999_999 }), fc.nat({ max: 99_999_999 }), (whole, fraction) => {
        const text = `${String(whole)}.${String(fraction).padStart(8, '0')}`;
        expect(btcToSats(text)).toBe(BigInt(whole) * 100_000_000n + BigInt(fraction));
      }),
    );
  });
});

describe('satsToBtc', () => {
  it('renders the fixed 8-digit-fraction form bitcoind emits', () => {
    expect(satsToBtc(0n)).toBe('0.00000000');
    expect(satsToBtc(1n)).toBe('0.00000001');
    expect(satsToBtc(5_000_000_000n)).toBe('50.00000000');
    expect(satsToBtc(-500_000n)).toBe('-0.00500000');
    expect(satsToBtc(2_100_000_000_000_000n)).toBe('21000000.00000000');
  });
});
