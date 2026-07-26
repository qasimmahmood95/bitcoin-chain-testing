/**
 * DR-02 — library derivation vs the node's `deriveaddresses`, plus the
 * node-side network guard pin.
 *
 * Chain events driven: none (pure descriptor evaluation on both sides —
 *   nothing is imported, mined, or broadcast).
 * Invariant: for the same account key, the library and `deriveaddresses`
 *   produce identical address lists over range [0,49], receive and change,
 *   for both wpkh and tr descriptors; a mainnet-encoded key inside a
 *   descriptor is rejected by the regtest node (both observers enforce the
 *   network boundary).
 * Custody risk: watcher/signer drift — two components derive differently
 *   and deposits fall between them.
 * Falsification lever: FALSIFY=DR-02 shifts the library's range by one;
 *   every list comparison goes red at the first element.
 */

import { describe, expect, it } from 'vitest';
import {
  accountDescriptor,
  deriveAddress,
  parseAccountPublicKey,
  type Branch,
  type ScriptType,
} from '../../src/core/derivation.js';
import { RpcError } from '../../src/rpc/client.js';
import { falsifyActive } from '../../src/testing/falsify.js';
import { connectRegtest } from '../../src/testing/node.js';
import { FIXED_ACCOUNT_TPUB } from '../support/fixed-account.js';

const RANGE: readonly [number, number] = [0, 49];

const BIP84_MAINNET_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

describe('DR-02: derivation parity against deriveaddresses', () => {
  const node = connectRegtest();

  // FALSIFY=DR-02: the library derives indices shifted by one.
  const shift = falsifyActive('DR-02') ? 1 : 0;

  async function assertParity(scriptType: ScriptType, branch: Branch): Promise<void> {
    const account = parseAccountPublicKey(FIXED_ACCOUNT_TPUB, { network: 'regtest', scriptType });
    const libraryAddresses = [];
    for (let index = RANGE[0]; index <= RANGE[1]; index += 1) {
      libraryAddresses.push(deriveAddress(account, branch, index + shift));
    }
    const { descriptor } = await node.getDescriptorInfo(accountDescriptor(account, branch));
    const nodeAddresses = await node.deriveAddresses(descriptor, RANGE);
    expect(nodeAddresses).toHaveLength(RANGE[1] - RANGE[0] + 1);
    expect(libraryAddresses, `${scriptType}/${branch}`).toEqual(nodeAddresses);
  }

  it('wpkh receive and change ranges agree byte-exactly', async () => {
    await assertParity('p2wpkh', 'receive');
    await assertParity('p2wpkh', 'change');
  });

  it('tr receive and change ranges agree byte-exactly', async () => {
    await assertParity('p2tr', 'receive');
    await assertParity('p2tr', 'change');
  });

  it('node refuses a mainnet-encoded key in a descriptor, like the library does', async () => {
    let caught: unknown;
    try {
      await node.getDescriptorInfo(`wpkh(${BIP84_MAINNET_ZPUB}/0/*)`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).code).toBe(-5);
  });
});
