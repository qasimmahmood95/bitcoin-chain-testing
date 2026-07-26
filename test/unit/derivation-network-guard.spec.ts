/**
 * DR-04 — cross-network and key-material guards.
 *
 * Chain events driven: none (pure).
 * Invariant: mainnet-encoded material fed to a regtest-configured library
 *   (and vice versa) is rejected with a typed error, never silently
 *   re-encoded; private-versioned extended keys are rejected outright;
 *   bech32 addresses only pass the guard on their own network.
 * Custody risk: cross-network address confusion — funds burned to an
 *   address nobody controls on that chain; private keys creeping into
 *   watching infrastructure.
 * Falsification lever: FALSIFY=DR-04 hands the library correctly-matched
 *   material in the mismatch scenarios — the expected rejections never
 *   happen and the assertions go red.
 */

import bs58check from 'bs58check';
import { describe, expect, it } from 'vitest';
import {
  AccountKeyError,
  AddressNetworkError,
  assertAddressNetwork,
  deriveAddress,
  NetworkMismatchError,
  parseAccountPublicKey,
  PrivateKeyMaterialError,
  ScriptTypeMismatchError,
  type Network,
} from '../../src/core/derivation.js';
import { falsifyActive } from '../../src/testing/falsify.js';
import { FIXED_ACCOUNT_TPUB } from '../support/fixed-account.js';

const BIP84_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

// FALSIFY=DR-04: align the configured network with the key so the guard
// never has a mismatch to reject — the expect-throw assertions go red.
function expectedNetworkForMainnetKey(): Network {
  return falsifyActive('DR-04') ? 'mainnet' : 'regtest';
}
function expectedNetworkForTestKey(): Network {
  return falsifyActive('DR-04') ? 'regtest' : 'mainnet';
}

/** Re-encode a public extended key under a private version byte — a
 * syntactically-private key whose payload is still public data, so the
 * rejection path is testable with zero real key material in the repo. */
function withVersion(encoded: string, versionHex: string): string {
  const payload = bs58check.decode(encoded);
  return bs58check.encode(
    Buffer.concat([Buffer.from(versionHex, 'hex'), Buffer.from(payload.subarray(4))]),
  );
}

describe('DR-04: network and key-material guards', () => {
  it('rejects a mainnet-encoded key on a regtest-configured library', () => {
    expect(() =>
      parseAccountPublicKey(BIP84_ZPUB, {
        network: expectedNetworkForMainnetKey(),
        scriptType: 'p2wpkh',
      }),
    ).toThrow(NetworkMismatchError);
  });

  it('rejects a test-encoded key on a mainnet-configured library', () => {
    expect(() =>
      parseAccountPublicKey(FIXED_ACCOUNT_TPUB, {
        network: expectedNetworkForTestKey(),
        scriptType: 'p2wpkh',
      }),
    ).toThrow(NetworkMismatchError);
  });

  it('rejects a SLIP-132 prefix that promises a different script type', () => {
    expect(() =>
      parseAccountPublicKey(BIP84_ZPUB, { network: 'mainnet', scriptType: 'p2tr' }),
    ).toThrow(ScriptTypeMismatchError);
  });

  it('rejects private-versioned extended keys outright (watch-only stance)', () => {
    const zprvVersioned = withVersion(BIP84_ZPUB, '04b2430c');
    expect(() =>
      parseAccountPublicKey(zprvVersioned, { network: 'mainnet', scriptType: 'p2wpkh' }),
    ).toThrow(PrivateKeyMaterialError);

    const tprvVersioned = withVersion(FIXED_ACCOUNT_TPUB, '04358394');
    expect(() =>
      parseAccountPublicKey(tprvVersioned, { network: 'regtest', scriptType: 'p2wpkh' }),
    ).toThrow(PrivateKeyMaterialError);
  });

  it('rejects malformed key material with a typed error', () => {
    for (const bad of ['', 'not-a-key', 'xpub-truncated', bs58check.encode(Buffer.alloc(10))]) {
      expect(() =>
        parseAccountPublicKey(bad, { network: 'mainnet', scriptType: 'p2wpkh' }),
      ).toThrow(AccountKeyError);
    }
  });

  it('address guard: HRP must match the configured network, never re-encoded', () => {
    const mainnetAddress = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
    expect(() => assertAddressNetwork(mainnetAddress, 'regtest')).toThrow(AddressNetworkError);

    const regtest = parseAccountPublicKey(FIXED_ACCOUNT_TPUB, {
      network: 'regtest',
      scriptType: 'p2wpkh',
    });
    const regtestAddress = deriveAddress(regtest, 'receive', 0);
    expect(regtestAddress.startsWith('bcrt1')).toBe(true);
    expect(() => assertAddressNetwork(regtestAddress, 'regtest')).not.toThrow();
    expect(() => assertAddressNetwork(regtestAddress, 'mainnet')).toThrow(AddressNetworkError);

    // Testnet material is foreign to BOTH configured networks.
    const testnetAddress = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    expect(() => assertAddressNetwork(testnetAddress, 'regtest')).toThrow(AddressNetworkError);
    expect(() => assertAddressNetwork(testnetAddress, 'mainnet')).toThrow(AddressNetworkError);
  });
});
