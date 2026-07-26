/**
 * TX-01 — exact value conservation, agreed with the node to the satoshi.
 *
 * Chain events driven: fund a watched (signing-wallet-account) address;
 *   mine to N; build a spend; PSBT hand-off to the node wallet; validate
 *   via testmempoolaccept; broadcast and mine 1.
 * Invariant: Σ inputs = Σ outputs + fee exactly in bigint sats, and the
 *   NODE's fee accounting (testmempoolaccept fees.base) equals the
 *   builder's fee exactly; change goes to the derived internal-chain
 *   address; the node accepts and the tx confirms.
 * Custody risk: fee leak / value destruction; change to a foreign address.
 * Falsification lever: FALSIFY=TX-01 (unit lever) drops one satoshi into
 *   the observed fee; here, the exact node-fee equality is the live pin.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { deriveAddress } from '../../src/core/derivation.js';
import { buildSpend } from '../../src/core/txbuild.js';
import type { BitcoindRpc } from '../../src/rpc/bitcoind.js';
import {
  connectRegtest,
  ensureSpendableFunds,
  mineToWallet,
  openSigningWallet,
} from '../../src/testing/node.js';
import { signingWalletAccount } from '../support/signing-account.js';
import { signAndTestAccept, spendableUtxosAt } from '../support/tx-fixture.js';

const N = 6;
const FUND_SATS = 3_000_000n;
const PAY_SATS = 1_000_000n;

describe('TX-01: value conservation to the satoshi', () => {
  const node = connectRegtest();
  let signing: BitcoindRpc;
  let watchedAddress: string;
  let changeAddress: string;

  beforeAll(async () => {
    signing = await openSigningWallet(node);
    await ensureSpendableFunds(node, signing, FUND_SATS + 10_000_000n);
    const account = await signingWalletAccount(signing);
    watchedAddress = deriveAddress(account, 'receive', 30);
    changeAddress = deriveAddress(account, 'change', 30);
  });

  it('builder fee equals the node fee exactly; the spend confirms', async () => {
    const fundTxid = await signing.sendToAddress(watchedAddress, FUND_SATS, 25);
    await mineToWallet(node, signing, N);

    const utxos = (await spendableUtxosAt(signing, [watchedAddress])).filter(
      (u) => u.outpoint.txid === fundTxid,
    );
    expect(utxos).toHaveLength(1);

    const built = buildSpend({
      utxos,
      reserved: new Set(),
      finalityDepth: N,
      payAddress: await signing.getNewAddress('bech32'),
      paySats: PAY_SATS,
      changeAddress,
      feeRateSatPerVb: 25n,
      dustThresholdSats: 546n,
    });

    // Library-side conservation.
    const inputSum = utxos
      .filter((u) =>
        built.inputs.some((i) => i.txid === u.outpoint.txid && i.vout === u.outpoint.vout),
      )
      .reduce((sum, u) => sum + u.amountSats, 0n);
    const outputSum = built.outputs.reduce((sum, o) => sum + o.sats, 0n);
    expect(inputSum).toBe(outputSum + built.feeSats);
    expect(built.outputs.at(-1)?.address).toBe(changeAddress);

    // Node-side conservation: its fee accounting must equal ours EXACTLY.
    const { hex, accept } = await signAndTestAccept(node, signing, built);
    expect(accept?.allowed).toBe(true);
    expect(accept?.feeSats).toBe(built.feeSats);
    expect(accept?.vsize).toBeDefined();
    expect(accept?.vsize ?? Infinity).toBeLessThanOrEqual(built.estimatedVsize);

    const txid = await node.sendRawTransaction(hex);
    await mineToWallet(node, signing, 1);
    expect((await signing.getTransaction(txid)).confirmations).toBe(1);
  });
});
