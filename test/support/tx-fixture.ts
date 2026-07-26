/**
 * Shared TX/FE plumbing: watched-UTXO collection and the PSBT hand-off
 * (library builds → node wallet signs → finalize → testmempoolaccept as
 * the node-side acceptance oracle).
 */

import { satsToBtc } from '../../src/rpc/amount.js';
import type { BitcoindRpc, MempoolAcceptResult } from '../../src/rpc/bitcoind.js';
import type { SpendableUtxo, BuiltSpend } from '../../src/core/txbuild.js';

export async function spendableUtxosAt(
  wallet: BitcoindRpc,
  addresses: readonly string[],
): Promise<SpendableUtxo[]> {
  const utxos = await wallet.listUnspent(0, addresses);
  return utxos.map((u) => ({
    outpoint: { txid: u.txid, vout: u.vout },
    amountSats: u.amountSats,
    confirmations: u.confirmations,
  }));
}

export async function signAndTestAccept(
  node: BitcoindRpc,
  signing: BitcoindRpc,
  built: BuiltSpend,
): Promise<{ hex: string; accept: MempoolAcceptResult | undefined }> {
  const outputs: Record<string, string> = {};
  for (const output of built.outputs) {
    outputs[output.address] = satsToBtc(output.sats);
  }
  const psbt = await node.createPsbt(
    built.inputs.map((i) => ({ txid: i.txid, vout: i.vout })),
    outputs,
  );
  const processed = await signing.walletProcessPsbt(psbt);
  if (!processed.complete) {
    throw new Error('wallet could not fully sign the PSBT');
  }
  const finalized = await node.finalizePsbt(processed.psbt);
  if (!finalized.complete) {
    throw new Error('PSBT did not finalize');
  }
  const [accept] = await node.testMempoolAccept([finalized.hex]);
  return { hex: finalized.hex, accept };
}
