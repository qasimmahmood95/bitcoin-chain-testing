/**
 * Typed wrappers for exactly the bitcoind RPCs the scenarios consume —
 * nothing more (hard limit 1: every export exists because a scenario uses
 * it). Amount-bearing fields cross the boundary as bigint satoshis
 * (ADR-0004).
 */

import { JsonRpcClient } from './client.js';
import {
  asArray,
  asBoolean,
  asInteger,
  asObject,
  asOptional,
  asSats,
  asString,
  asStringArray,
} from './decode.js';

export interface BlockchainInfo {
  readonly chain: string;
  readonly blocks: number;
  readonly bestBlockHash: string;
}

export interface CoinbaseOutpoint {
  readonly txid: string;
  readonly vout: number;
  readonly valueSats: bigint;
}

export interface SignedTransaction {
  readonly hex: string;
  readonly complete: boolean;
}

export interface MempoolAcceptResult {
  readonly txid: string;
  readonly allowed: boolean;
  readonly rejectReason: string | undefined;
}

export interface SmartFeeEstimate {
  readonly blocks: number;
  readonly feeRateSatsPerKvB: bigint | undefined;
  readonly errors: string[] | undefined;
}

export class BitcoindRpc {
  constructor(readonly rpc: JsonRpcClient) {}

  /** Same node, wallet-scoped endpoint. */
  forWallet(walletName: string): BitcoindRpc {
    return new BitcoindRpc(this.rpc.forWallet(walletName));
  }

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    const info = asObject(await this.rpc.call('getblockchaininfo'), 'getblockchaininfo');
    return {
      chain: asString(info['chain'], 'getblockchaininfo.chain'),
      blocks: asInteger(info['blocks'], 'getblockchaininfo.blocks'),
      bestBlockHash: asString(info['bestblockhash'], 'getblockchaininfo.bestblockhash'),
    };
  }

  async getBlockCount(): Promise<number> {
    return asInteger(await this.rpc.call('getblockcount'), 'getblockcount');
  }

  async getBlockHash(height: number): Promise<string> {
    return asString(await this.rpc.call('getblockhash', [height]), 'getblockhash');
  }

  async createWallet(walletName: string): Promise<void> {
    await this.rpc.call('createwallet', [walletName]);
  }

  async loadWallet(walletName: string): Promise<void> {
    await this.rpc.call('loadwallet', [walletName]);
  }

  async listWallets(): Promise<string[]> {
    return asStringArray(await this.rpc.call('listwallets'), 'listwallets');
  }

  async getNewAddress(): Promise<string> {
    return asString(await this.rpc.call('getnewaddress'), 'getnewaddress');
  }

  async generateToAddress(blocks: number, address: string): Promise<string[]> {
    return asStringArray(
      await this.rpc.call('generatetoaddress', [blocks, address]),
      'generatetoaddress',
    );
  }

  /** The coinbase's first output, read via `getblock <hash> 2`. */
  async getCoinbaseOutpoint(blockHash: string): Promise<CoinbaseOutpoint> {
    const block = asObject(await this.rpc.call('getblock', [blockHash, 2]), 'getblock');
    const transactions = asArray(block['tx'], 'getblock.tx');
    const coinbase = asObject(transactions[0], 'getblock.tx[0]');
    const outputs = asArray(coinbase['vout'], 'getblock.tx[0].vout');
    const first = asObject(outputs[0], 'getblock.tx[0].vout[0]');
    return {
      txid: asString(coinbase['txid'], 'getblock.tx[0].txid'),
      vout: 0,
      valueSats: asSats(first['value'], 'getblock.tx[0].vout[0].value'),
    };
  }

  /** Outputs map address → BTC decimal string (exact; never a float). */
  async createRawTransaction(
    inputs: readonly { txid: string; vout: number }[],
    outputs: Readonly<Record<string, string>>,
  ): Promise<string> {
    return asString(
      await this.rpc.call('createrawtransaction', [inputs, outputs]),
      'createrawtransaction',
    );
  }

  async signRawTransactionWithWallet(rawTx: string): Promise<SignedTransaction> {
    const signed = asObject(
      await this.rpc.call('signrawtransactionwithwallet', [rawTx]),
      'signrawtransactionwithwallet',
    );
    return {
      hex: asString(signed['hex'], 'signrawtransactionwithwallet.hex'),
      complete: asBoolean(signed['complete'], 'signrawtransactionwithwallet.complete'),
    };
  }

  async testMempoolAccept(rawTxs: readonly string[]): Promise<MempoolAcceptResult[]> {
    const results = asArray(
      await this.rpc.call('testmempoolaccept', [rawTxs]),
      'testmempoolaccept',
    );
    return results.map((entry, index) => {
      const context = `testmempoolaccept[${String(index)}]`;
      const record = asObject(entry, context);
      return {
        txid: asString(record['txid'], `${context}.txid`),
        allowed: asBoolean(record['allowed'], `${context}.allowed`),
        rejectReason: asOptional(record['reject-reason'], asString, `${context}.reject-reason`),
      };
    });
  }

  async sendRawTransaction(rawTx: string): Promise<string> {
    return asString(await this.rpc.call('sendrawtransaction', [rawTx]), 'sendrawtransaction');
  }

  async getRawMempool(): Promise<string[]> {
    return asStringArray(await this.rpc.call('getrawmempool'), 'getrawmempool');
  }

  /** Feerate, when present, is BTC/kvB on the wire → bigint sats/kvB here. */
  async estimateSmartFee(confTarget: number): Promise<SmartFeeEstimate> {
    const estimate = asObject(
      await this.rpc.call('estimatesmartfee', [confTarget]),
      'estimatesmartfee',
    );
    return {
      blocks: asInteger(estimate['blocks'], 'estimatesmartfee.blocks'),
      feeRateSatsPerKvB: asOptional(estimate['feerate'], asSats, 'estimatesmartfee.feerate'),
      errors: asOptional(estimate['errors'], asStringArray, 'estimatesmartfee.errors'),
    };
  }
}
