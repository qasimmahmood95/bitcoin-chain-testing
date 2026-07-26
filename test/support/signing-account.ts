/**
 * The TX/FE scenarios need watched UTXOs the node-side wallet can SIGN —
 * so the "custodian account" is the signing wallet's own account-level
 * PUBLIC key, extracted per run from its public descriptor (never stored;
 * the private half never leaves the disposable container — hard limit 2).
 */

import { parseAccountPublicKey, type WatchAccount } from '../../src/core/derivation.js';
import type { BitcoindRpc } from '../../src/rpc/bitcoind.js';

export async function signingWalletAccount(signing: BitcoindRpc): Promise<WatchAccount> {
  const descriptors = await signing.listDescriptors();
  const external = descriptors.find((d) => d.startsWith('wpkh(') && d.includes('/0/*'));
  if (external === undefined) {
    throw new Error('signing wallet has no wpkh external descriptor');
  }
  const tpub = /tpub[0-9A-Za-z]+/.exec(external)?.[0];
  if (tpub === undefined) {
    throw new Error(`no tpub in descriptor: ${external}`);
  }
  return parseAccountPublicKey(tpub, { network: 'regtest', scriptType: 'p2wpkh' });
}
