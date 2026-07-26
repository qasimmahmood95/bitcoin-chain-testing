/**
 * Shared watch-only fixture for the CF scenarios: the fixed public-only
 * account imported (idempotently) into the disable_private_keys wallet.
 * Every CF spec watches its own dedicated derivation indexes, so specs
 * stay isolated on the shared regtest chain.
 */

import {
  accountDescriptor,
  parseAccountPublicKey,
  type WatchAccount,
} from '../../src/core/derivation.js';
import type { BitcoindRpc } from '../../src/rpc/bitcoind.js';
import { openWatchOnlyWallet } from '../../src/testing/node.js';
import { FIXED_ACCOUNT_TPUB } from './fixed-account.js';

export const WATCH_RANGE: readonly [number, number] = [0, 49];

export function fixedAccount(): WatchAccount {
  return parseAccountPublicKey(FIXED_ACCOUNT_TPUB, { network: 'regtest', scriptType: 'p2wpkh' });
}

export async function watchOnlyFixture(
  node: BitcoindRpc,
): Promise<{ account: WatchAccount; watch: BitcoindRpc }> {
  const account = fixedAccount();
  const watch = await openWatchOnlyWallet(node);
  const receive = await node.getDescriptorInfo(accountDescriptor(account, 'receive'));
  const change = await node.getDescriptorInfo(accountDescriptor(account, 'change'));
  await watch.importDescriptors([
    {
      desc: receive.descriptor,
      active: true,
      internal: false,
      range: WATCH_RANGE,
      timestamp: 'now',
    },
    { desc: change.descriptor, active: true, internal: true, range: WATCH_RANGE, timestamp: 'now' },
  ]);
  return { account, watch };
}
