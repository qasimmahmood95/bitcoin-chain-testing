/**
 * M1 smoke — chain identity and deterministic genesis.
 *
 * Chain events driven: none (pure reads against the fresh stack).
 * Invariant: the node is regtest and block 0 is the canonical regtest
 *   genesis hash — every run starts from the identical chain (fresh-chain
 *   guarantee: no volume survives `npm run stack:down`).
 * Custody risk: a watcher silently pointed at the wrong network — every
 *   downstream observation and assertion becomes meaningless.
 * Falsification lever: FALSIFY=SMOKE flips the pinned genesis constant;
 *   the comparison against the live chain goes red.
 */

import { describe, expect, it } from 'vitest';
import { falsifyActive } from '../../src/testing/falsify.js';
import { connectRegtest } from '../../src/testing/node.js';

const REGTEST_GENESIS_HASH = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';

// FALSIFY=SMOKE: a wrong pin must be caught by the live chain, proving the
// comparison actually consults the node.
const EXPECTED_GENESIS = falsifyActive('SMOKE')
  ? REGTEST_GENESIS_HASH.replace('0f9188', 'deadbe')
  : REGTEST_GENESIS_HASH;

describe('M1 smoke', () => {
  const node = connectRegtest();

  it('answers getblockchaininfo as a regtest node', async () => {
    const info = await node.getBlockchainInfo();
    expect(info.chain).toBe('regtest');
    expect(info.bestBlockHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('starts from the canonical regtest genesis block', async () => {
    expect(await node.getBlockHash(0)).toBe(EXPECTED_GENESIS);
  });
});
