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
 * Falsification lever: FALSIFY=FEE-PIN flips the pinned error string —
 *   red exactly because the live estimator answers with the real message.
 */

import { describe, expect, it } from 'vitest';
import { falsifyActive } from '../../src/testing/falsify.js';
import { connectRegtest } from '../../src/testing/node.js';

describe('M1 characterization: estimatesmartfee on regtest', () => {
  const node = connectRegtest();

  it('has no feerate and reports insufficient data', async () => {
    const estimate = await node.estimateSmartFee(6);
    expect(estimate.feeRateSatsPerKvB).toBeUndefined();
    // FALSIFY=FEE-PIN flips the pinned error string — red iff the live
    // estimator actually answered with the real message, proving the pin
    // consults the node rather than restating itself.
    const expectedErrors = falsifyActive('FEE-PIN')
      ? ['Insufficient data or no feerate found (falsified pin)']
      : ['Insufficient data or no feerate found'];
    expect(estimate.errors).toEqual(expectedErrors);
  });
});
