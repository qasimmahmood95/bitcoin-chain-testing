/**
 * Fee policy (M5, FE-01/FE-02): clamped feerate selection with a typed
 * estimator-unavailable fallback. Pure — the estimator's output arrives as
 * data; regtest's permanently-failing estimator is the fixture, not an
 * obstacle. `number` never holds a feerate: sat/vB as bigint throughout.
 */

export interface FeePolicyConfig {
  /** Never bid below this — unrelayable withdrawals are an outage. */
  readonly floorSatPerVb: bigint;
  /** Never bid above this — one absurd estimate must not drain the wallet. */
  readonly ceilingSatPerVb: bigint;
}

export type EstimatorResult =
  | { readonly kind: 'unavailable'; readonly errors: readonly string[] }
  | { readonly kind: 'estimate'; readonly feeRateSatsPerKvB: bigint };

export type FeeRateSource = 'estimator' | 'floor-fallback' | 'clamped-floor' | 'clamped-ceiling';

export interface ChosenFeeRate {
  readonly satPerVb: bigint;
  readonly source: FeeRateSource;
}

export class FeePolicyConfigError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'FeePolicyConfigError';
  }
}

/** kvB → vB, rounded UP so the chosen rate never bids under the estimate. */
function satsPerKvbToSatsPerVb(satsPerKvb: bigint): bigint {
  return (satsPerKvb + 999n) / 1000n;
}

export function chooseFeeRate(config: FeePolicyConfig, estimator: EstimatorResult): ChosenFeeRate {
  if (config.floorSatPerVb < 1n || config.ceilingSatPerVb < config.floorSatPerVb) {
    throw new FeePolicyConfigError(
      `invalid fee bounds: floor ${String(config.floorSatPerVb)}, ceiling ${String(config.ceilingSatPerVb)}`,
    );
  }
  if (estimator.kind === 'unavailable') {
    // FE-01: the expected path on regtest, and the survival path live —
    // typed, deliberate, never a throw.
    return { satPerVb: config.floorSatPerVb, source: 'floor-fallback' };
  }
  const estimated = satsPerKvbToSatsPerVb(estimator.feeRateSatsPerKvB);
  if (estimated < config.floorSatPerVb) {
    return { satPerVb: config.floorSatPerVb, source: 'clamped-floor' };
  }
  if (estimated > config.ceilingSatPerVb) {
    return { satPerVb: config.ceilingSatPerVb, source: 'clamped-ceiling' };
  }
  return { satPerVb: estimated, source: 'estimator' };
}
