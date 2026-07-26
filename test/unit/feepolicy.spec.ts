/**
 * FE-02 (unit) — the chosen feerate is always inside [floor, ceiling],
 * whatever the estimator says.
 *
 * Chain events driven: none (pure — fast-check estimator outputs).
 * Invariant: absurd-high, absurd-low, zero, and error estimator outputs
 *   all map to a rate within the configured clamp; unavailability is a
 *   typed floor-fallback, never a throw.
 * Custody risk: hot-wallet drain via one absurd estimate paid as fees;
 *   withdrawal outage when the estimator degrades.
 * Falsification lever: FALSIFY=FE-02 removes the ceiling from the fixture
 *   config; the within-bounds property goes red on absurd estimates.
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  chooseFeeRate,
  FeePolicyConfigError,
  type EstimatorResult,
  type FeePolicyConfig,
} from '../../src/core/feepolicy.js';
import { falsifyActive } from '../../src/testing/falsify.js';

const FLOOR = 2n;
const CEILING = 50n;

// FALSIFY=FE-02: no ceiling — one absurd estimate is paid as bid.
function config(): FeePolicyConfig {
  return {
    floorSatPerVb: FLOOR,
    ceilingSatPerVb: falsifyActive('FE-02') ? 1n << 62n : CEILING,
  };
}

const estimatorArb: fc.Arbitrary<EstimatorResult> = fc.oneof(
  fc.record({
    kind: fc.constant('estimate' as const),
    feeRateSatsPerKvB: fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
  }),
  fc.record({
    kind: fc.constant('unavailable' as const),
    errors: fc.array(fc.string(), { maxLength: 2 }),
  }),
);

describe('chooseFeeRate', () => {
  it('always lands inside [floor, ceiling] (property)', () => {
    fc.assert(
      fc.property(estimatorArb, (estimator) => {
        const chosen = chooseFeeRate(config(), estimator);
        expect(chosen.satPerVb).toBeGreaterThanOrEqual(FLOOR);
        expect(chosen.satPerVb).toBeLessThanOrEqual(CEILING);
      }),
      { numRuns: 300 },
    );
  });

  it('estimator unavailability is a typed floor fallback, never a throw', () => {
    const chosen = chooseFeeRate(config(), {
      kind: 'unavailable',
      errors: ['Insufficient data or no feerate found'],
    });
    expect(chosen).toEqual({ satPerVb: FLOOR, source: 'floor-fallback' });
  });

  it('converts kvB to vB rounding up, then clamps', () => {
    const bounds: FeePolicyConfig = { floorSatPerVb: 1n, ceilingSatPerVb: 1_000n };
    expect(chooseFeeRate(bounds, { kind: 'estimate', feeRateSatsPerKvB: 1_000n }).satPerVb).toBe(
      1n,
    );
    expect(chooseFeeRate(bounds, { kind: 'estimate', feeRateSatsPerKvB: 1_001n }).satPerVb).toBe(
      2n,
    );
    expect(
      chooseFeeRate(
        { floorSatPerVb: FLOOR, ceilingSatPerVb: CEILING },
        {
          kind: 'estimate',
          feeRateSatsPerKvB: 1n,
        },
      ),
    ).toEqual({ satPerVb: FLOOR, source: 'clamped-floor' });
    expect(
      chooseFeeRate(
        { floorSatPerVb: FLOOR, ceilingSatPerVb: CEILING },
        {
          kind: 'estimate',
          feeRateSatsPerKvB: 10_000_000n,
        },
      ),
    ).toEqual({ satPerVb: CEILING, source: 'clamped-ceiling' });
  });

  it('rejects nonsensical bounds loudly', () => {
    expect(() =>
      chooseFeeRate(
        { floorSatPerVb: 0n, ceilingSatPerVb: 10n },
        { kind: 'unavailable', errors: [] },
      ),
    ).toThrow(FeePolicyConfigError);
    expect(() =>
      chooseFeeRate(
        { floorSatPerVb: 10n, ceilingSatPerVb: 5n },
        { kind: 'unavailable', errors: [] },
      ),
    ).toThrow(FeePolicyConfigError);
  });
});
