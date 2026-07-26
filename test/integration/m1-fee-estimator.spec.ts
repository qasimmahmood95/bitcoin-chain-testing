/**
 * M1 characterization — the regtest fee estimator is unavailable by
 * design. [pin — the fixture FE-01 builds on]
 *
 * Chain events driven: none (estimatesmartfee consults fee history, which a
 *   deterministic fresh chain does not have — and must not be given).
 * Invariant: estimatesmartfee returns no feerate and exactly the error
 *   "Insufficient data or no feerate found".
 * Custody risk: fee logic that assumes the estimator always answers —
 *   withdrawal outage the moment it degrades (a live-incident classic).
 * Falsification lever: FALSIFY=FEE-PIN (harness lands M2) asserts a feerate
 *   is present — red on every run.
 */

import { describe, expect, it } from 'vitest';
import { connectRegtest } from '../../src/testing/node.js';

describe('M1 characterization: estimatesmartfee on regtest', () => {
  const node = connectRegtest();

  it('has no feerate and reports insufficient data', async () => {
    const estimate = await node.estimateSmartFee(6);
    expect(estimate.feeRateSatsPerKvB).toBeUndefined();
    expect(estimate.errors).toEqual(['Insufficient data or no feerate found']);
  });
});
