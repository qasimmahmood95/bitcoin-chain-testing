/**
 * DR-01 — derivation pinned to the published BIP84/BIP86 test vectors.
 *
 * Chain events driven: none (pure; mainnet vectors, public-key side only —
 *   no xprv appears anywhere, hard limit 2).
 * Invariant: receive and change addresses derived from the published
 *   account-level public keys match the published vector addresses
 *   byte-exactly at the first, second, and last published index.
 * Custody risk: deposits invited to addresses the signer can't spend or
 *   the watcher doesn't watch — silent, permanent fund loss.
 * Falsification lever: FALSIFY=DR-01 swaps the receive/change branch the
 *   fixture requests; every vector comparison goes red.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveAddress,
  parseAccountPublicKey,
  type Branch,
  type WatchAccount,
} from '../../src/core/derivation.js';
import { falsifyActive } from '../../src/testing/falsify.js';

// Published in bip-0084.mediawiki (account m/84'/0'/0' of the standard test mnemonic).
const BIP84_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const BIP84_VECTORS: readonly [Branch, number, string][] = [
  ['receive', 0, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'],
  ['receive', 1, 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'],
  ['change', 0, 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'],
];

// Published in bip-0086.mediawiki (account m/86'/0'/0' of the same mnemonic).
const BIP86_XPUB =
  'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ';
const BIP86_VECTORS: readonly [Branch, number, string][] = [
  ['receive', 0, 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'],
  ['receive', 1, 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh'],
  ['change', 0, 'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7'],
];

// FALSIFY=DR-01: the fixture asks for the wrong branch — receive vectors
// are answered with change-branch addresses and vice versa.
function branchUnderTest(branch: Branch): Branch {
  if (!falsifyActive('DR-01')) {
    return branch;
  }
  return branch === 'receive' ? 'change' : 'receive';
}

function assertVectors(account: WatchAccount, vectors: readonly [Branch, number, string][]): void {
  for (const [branch, index, published] of vectors) {
    expect(
      deriveAddress(account, branchUnderTest(branch), index),
      `${branch}/${String(index)}`,
    ).toBe(published);
  }
}

describe('DR-01: published vector pins', () => {
  it('BIP84 — zpub account key derives the published P2WPKH addresses', () => {
    const account = parseAccountPublicKey(BIP84_ZPUB, { network: 'mainnet', scriptType: 'p2wpkh' });
    expect(account.canonicalKey.startsWith('xpub')).toBe(true);
    assertVectors(account, BIP84_VECTORS);
  });

  it('BIP86 — xpub account key derives the published P2TR addresses', () => {
    const account = parseAccountPublicKey(BIP86_XPUB, { network: 'mainnet', scriptType: 'p2tr' });
    assertVectors(account, BIP86_VECTORS);
  });
});
