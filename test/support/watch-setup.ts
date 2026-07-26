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

/**
 * Import only descriptors the wallet does not already hold. Core rejects a
 * re-import of an active descriptor once the wallet has auto-extended its
 * range past ours ("new range must include current range"), so idempotence
 * has to come from a listdescriptors guard, not from re-importing.
 */
export async function ensureWatchDescriptors(
  node: BitcoindRpc,
  watch: BitcoindRpc,
  account: WatchAccount,
): Promise<void> {
  const receive = await node.getDescriptorInfo(accountDescriptor(account, 'receive'));
  const change = await node.getDescriptorInfo(accountDescriptor(account, 'change'));
  const present = new Set(await watch.listDescriptors());
  const wanted = [
    {
      desc: receive.descriptor,
      active: true,
      internal: false,
      range: WATCH_RANGE,
      timestamp: 'now' as const,
    },
    {
      desc: change.descriptor,
      active: true,
      internal: true,
      range: WATCH_RANGE,
      timestamp: 'now' as const,
    },
  ].filter((request) => !present.has(request.desc));
  if (wanted.length > 0) {
    await watch.importDescriptors(wanted);
  }
}

export async function watchOnlyFixture(
  node: BitcoindRpc,
): Promise<{ account: WatchAccount; watch: BitcoindRpc }> {
  const account = fixedAccount();
  const watch = await openWatchOnlyWallet(node);
  await ensureWatchDescriptors(node, watch, account);
  return { account, watch };
}
