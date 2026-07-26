/**
 * DR-03 — deposit detection through a watch-only descriptor wallet with
 * zero key material present.
 *
 * Chain events driven: import ranged receive/change descriptors into a
 *   `disable_private_keys` wallet; fund the node-side signing wallet
 *   (mine to maturity if needed); send a deposit to a library-derived
 *   address; observe unconfirmed; mine 1 block; observe confirmed.
 * Invariant: the wallet reports `private_keys_enabled=false` before and
 *   after import; the deposit is detected at the exact outpoint with the
 *   exact bigint satoshi amount, first at 0 confirmations, then at 1.
 * Custody risk: private keys creeping into watching infrastructure (breach
 *   blast radius becomes total), and deposits to derived addresses going
 *   unseen.
 * Falsification lever: FALSIFY=DR-03 skips the descriptor import; the
 *   detection assertions find nothing and go red.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  accountDescriptor,
  assertAddressNetwork,
  deriveAddress,
  parseAccountPublicKey,
} from '../../src/core/derivation.js';
import type { BitcoindRpc } from '../../src/rpc/bitcoind.js';
import { falsifyActive } from '../../src/testing/falsify.js';
import {
  connectRegtest,
  ensureSpendableFunds,
  mineToWallet,
  openSigningWallet,
  openWatchOnlyWallet,
} from '../../src/testing/node.js';
import { pollUntil } from '../../src/testing/poll.js';
import { FIXED_ACCOUNT_TPUB } from '../support/fixed-account.js';

const DEPOSIT_SATS = 12_345_678n;
const DEPOSIT_INDEX = 7;
const IMPORT_RANGE: readonly [number, number] = [0, 49];

describe('DR-03: watch-only deposit detection', () => {
  const node = connectRegtest();
  const account = parseAccountPublicKey(FIXED_ACCOUNT_TPUB, {
    network: 'regtest',
    scriptType: 'p2wpkh',
  });
  let signing: BitcoindRpc;
  let watch: BitcoindRpc;

  beforeAll(async () => {
    signing = await openSigningWallet(node);
    watch = await openWatchOnlyWallet(node);
  });

  it('the watch-only wallet has private keys disabled from birth', async () => {
    const info = await watch.getWalletInfo();
    expect(info.privateKeysEnabled).toBe(false);
  });

  it('detects a deposit to a derived address with zero key material', async () => {
    // FALSIFY=DR-03: the import never happens — the wallet watches nothing.
    if (!falsifyActive('DR-03')) {
      const receive = await node.getDescriptorInfo(accountDescriptor(account, 'receive'));
      const change = await node.getDescriptorInfo(accountDescriptor(account, 'change'));
      await watch.importDescriptors([
        {
          desc: receive.descriptor,
          active: true,
          internal: false,
          range: IMPORT_RANGE,
          timestamp: 'now',
        },
        {
          desc: change.descriptor,
          active: true,
          internal: true,
          range: IMPORT_RANGE,
          timestamp: 'now',
        },
      ]);
    }

    const address = deriveAddress(account, 'receive', DEPOSIT_INDEX);
    assertAddressNetwork(address, 'regtest');

    await ensureSpendableFunds(node, signing, DEPOSIT_SATS + 1_000_000n);
    const txid = await signing.sendToAddress(address, DEPOSIT_SATS, 25);

    // Same node, so the mempool sighting is immediate; the budget is a
    // small explicit cushion, not a synchronization crutch. Filtering by
    // txid keeps re-runs against a warm stack (prior deposits at the same
    // derived address) out of the assertions.
    const unconfirmed = await pollUntil(
      'watch-only 0-conf sighting',
      { attempts: 5, delayMs: 200 },
      async () => {
        const utxos = (await watch.listUnspent(0, [address])).filter((u) => u.txid === txid);
        return utxos.length > 0 ? utxos : undefined;
      },
    );
    expect(unconfirmed).toHaveLength(1);
    expect(unconfirmed[0]?.amountSats).toBe(DEPOSIT_SATS);
    expect(unconfirmed[0]?.confirmations).toBe(0);
    const outpointVout = unconfirmed[0]?.vout;
    expect(outpointVout).toBeDefined();

    await mineToWallet(node, signing, 1);

    const confirmed = (await watch.listUnspent(1, [address])).filter((u) => u.txid === txid);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.vout).toBe(outpointVout);
    expect(confirmed[0]?.amountSats).toBe(DEPOSIT_SATS);
    expect(confirmed[0]?.confirmations).toBe(1);

    // Still zero key material after import and detection.
    const info = await watch.getWalletInfo();
    expect(info.privateKeysEnabled).toBe(false);
  });
});
