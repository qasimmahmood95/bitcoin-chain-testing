/**
 * Typed wrappers for exactly the bitcoind RPCs the scenarios consume —
 * nothing more (hard limit 1: every export exists because a scenario uses
 * it). Amount-bearing fields cross the boundary as bigint satoshis
 * (ADR-0004).
 */

import { satsToBtc } from './amount.js';
import { JsonRpcClient } from './client.js';
import type { JsonValue } from './json.js';
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
  /** Present when allowed: the node's own fee accounting — TX-01's oracle. */
  readonly feeSats: bigint | undefined;
  readonly vsize: number | undefined;
}

export interface SmartFeeEstimate {
  readonly blocks: number;
  readonly feeRateSatsPerKvB: bigint | undefined;
  readonly errors: string[] | undefined;
}

export interface BlockHeader {
  readonly height: number;
  readonly previousBlockHash: string | null;
}

export interface TransactionOutput {
  readonly vout: number;
  readonly address: string | null;
  readonly valueSats: bigint;
}

export interface TransactionInput {
  readonly txid: string;
  readonly vout: number;
}

export interface BlockWithTransactions {
  readonly hash: string;
  readonly height: number;
  readonly transactions: readonly {
    readonly txid: string;
    readonly inputs: readonly TransactionInput[];
    readonly outputs: readonly TransactionOutput[];
  }[];
}

/** Coinbase vins carry no txid and are skipped — they can conflict with nothing. */
function decodeTransactionInputs(vins: readonly JsonValue[], context: string): TransactionInput[] {
  const inputs: TransactionInput[] = [];
  vins.forEach((entry, index) => {
    const inContext = `${context}.vin[${String(index)}]`;
    const record = asObject(entry, inContext);
    const txid = asOptional(record['txid'], asString, `${inContext}.txid`);
    if (txid !== undefined) {
      inputs.push({ txid, vout: asInteger(record['vout'], `${inContext}.vout`) });
    }
  });
  return inputs;
}

function decodeTransactionOutputs(
  vouts: readonly JsonValue[],
  context: string,
): TransactionOutput[] {
  return vouts.map((entry, index) => {
    const outContext = `${context}.vout[${String(index)}]`;
    const record = asObject(entry, outContext);
    const scriptPubKey = asObject(record['scriptPubKey'], `${outContext}.scriptPubKey`);
    return {
      vout: asInteger(record['n'], `${outContext}.n`),
      address: asOptional(scriptPubKey['address'], asString, `${outContext}.address`) ?? null,
      valueSats: asSats(record['value'], `${outContext}.value`),
    };
  });
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

  async createWallet(walletName: string, opts?: { disablePrivateKeys?: boolean }): Promise<void> {
    await this.rpc.call('createwallet', {
      wallet_name: walletName,
      disable_private_keys: opts?.disablePrivateKeys ?? false,
    });
  }

  async getWalletInfo(): Promise<{ walletName: string; privateKeysEnabled: boolean }> {
    const info = asObject(await this.rpc.call('getwalletinfo'), 'getwalletinfo');
    return {
      walletName: asString(info['walletname'], 'getwalletinfo.walletname'),
      privateKeysEnabled: asBoolean(
        info['private_keys_enabled'],
        'getwalletinfo.private_keys_enabled',
      ),
    };
  }

  /** Canonicalizes a descriptor and appends its checksum. */
  async getDescriptorInfo(descriptor: string): Promise<{ descriptor: string; checksum: string }> {
    const info = asObject(
      await this.rpc.call('getdescriptorinfo', [descriptor]),
      'getdescriptorinfo',
    );
    return {
      descriptor: asString(info['descriptor'], 'getdescriptorinfo.descriptor'),
      checksum: asString(info['checksum'], 'getdescriptorinfo.checksum'),
    };
  }

  /** Imports ranged descriptors; throws if any import is not a success. */
  async importDescriptors(
    requests: readonly {
      desc: string;
      active: boolean;
      internal: boolean;
      range: readonly [number, number];
      timestamp: 'now';
    }[],
  ): Promise<void> {
    const results = asArray(
      await this.rpc.call('importdescriptors', [requests]),
      'importdescriptors',
    );
    results.forEach((entry, index) => {
      const context = `importdescriptors[${String(index)}]`;
      const record = asObject(entry, context);
      if (!asBoolean(record['success'], `${context}.success`)) {
        throw new Error(`${context}: import failed: ${JSON.stringify(record['error'])}`);
      }
    });
  }

  /** Descriptor strings (with checksums) already present in this wallet. */
  async listDescriptors(): Promise<string[]> {
    const result = asObject(await this.rpc.call('listdescriptors'), 'listdescriptors');
    return asArray(result['descriptors'], 'listdescriptors.descriptors').map((entry, index) => {
      const context = `listdescriptors.descriptors[${String(index)}]`;
      return asString(asObject(entry, context)['desc'], `${context}.desc`);
    });
  }

  async deriveAddresses(descriptor: string, range: readonly [number, number]): Promise<string[]> {
    return asStringArray(
      await this.rpc.call('deriveaddresses', [descriptor, range]),
      'deriveaddresses',
    );
  }

  async listUnspent(
    minConf: number,
    addresses: readonly string[],
  ): Promise<{ txid: string; vout: number; amountSats: bigint; confirmations: number }[]> {
    const results = asArray(
      await this.rpc.call('listunspent', [minConf, 9999999, addresses]),
      'listunspent',
    );
    return results.map((entry, index) => {
      const context = `listunspent[${String(index)}]`;
      const record = asObject(entry, context);
      return {
        txid: asString(record['txid'], `${context}.txid`),
        vout: asInteger(record['vout'], `${context}.vout`),
        amountSats: asSats(record['amount'], `${context}.amount`),
        confirmations: asInteger(record['confirmations'], `${context}.confirmations`),
      };
    });
  }

  /** Wallet-funded send with an explicit feerate — no estimator, no fallbackfee. */
  async sendToAddress(
    address: string,
    amountSats: bigint,
    feeRateSatPerVb: number,
  ): Promise<string> {
    if (!Number.isInteger(feeRateSatPerVb) || feeRateSatPerVb <= 0) {
      throw new RangeError(
        `fee rate must be a positive integer of sat/vB: ${String(feeRateSatPerVb)}`,
      );
    }
    return asString(
      await this.rpc.call('sendtoaddress', {
        address,
        amount: satsToBtc(amountSats),
        fee_rate: feeRateSatPerVb,
      }),
      'sendtoaddress',
    );
  }

  async getBalances(): Promise<{ trustedSats: bigint }> {
    const balances = asObject(await this.rpc.call('getbalances'), 'getbalances');
    const mine = asObject(balances['mine'], 'getbalances.mine');
    return { trustedSats: asSats(mine['trusted'], 'getbalances.mine.trusted') };
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

  async getBestBlockHash(): Promise<string> {
    return asString(await this.rpc.call('getbestblockhash'), 'getbestblockhash');
  }

  async getBlockHeader(blockHash: string): Promise<BlockHeader> {
    const header = asObject(await this.rpc.call('getblockheader', [blockHash]), 'getblockheader');
    return {
      height: asInteger(header['height'], 'getblockheader.height'),
      previousBlockHash:
        asOptional(header['previousblockhash'], asString, 'getblockheader.previousblockhash') ??
        null,
    };
  }

  /** Full block with per-transaction outputs, via `getblock <hash> 2` — the watcher's connect feed. */
  async getBlockWithTransactions(blockHash: string): Promise<BlockWithTransactions> {
    const block = asObject(await this.rpc.call('getblock', [blockHash, 2]), 'getblock');
    const transactions = asArray(block['tx'], 'getblock.tx').map((entry, index) => {
      const context = `getblock.tx[${String(index)}]`;
      const record = asObject(entry, context);
      return {
        txid: asString(record['txid'], `${context}.txid`),
        inputs: decodeTransactionInputs(asArray(record['vin'], `${context}.vin`), context),
        outputs: decodeTransactionOutputs(asArray(record['vout'], `${context}.vout`), context),
      };
    });
    return {
      hash: asString(block['hash'], 'getblock.hash'),
      height: asInteger(block['height'], 'getblock.height'),
      transactions,
    };
  }

  /** Decoded outputs of a mempool or chain transaction (txindex=1) — the watcher's mempool feed. */
  async getRawTransactionOutputs(txid: string): Promise<TransactionOutput[]> {
    const tx = asObject(
      await this.rpc.call('getrawtransaction', [txid, true]),
      'getrawtransaction',
    );
    return decodeTransactionOutputs(
      asArray(tx['vout'], 'getrawtransaction.vout'),
      'getrawtransaction',
    );
  }

  /** Decoded inputs of a transaction — the watcher's conflict index feed (RG-03). */
  async getRawTransactionInputs(txid: string): Promise<TransactionInput[]> {
    const tx = asObject(
      await this.rpc.call('getrawtransaction', [txid, true]),
      'getrawtransaction',
    );
    return decodeTransactionInputs(
      asArray(tx['vin'], 'getrawtransaction.vin'),
      'getrawtransaction',
    );
  }

  /** Deterministic single-node reorg primitives (ADR-0003). */
  async invalidateBlock(blockHash: string): Promise<void> {
    await this.rpc.call('invalidateblock', [blockHash]);
  }

  async reconsiderBlock(blockHash: string): Promise<void> {
    await this.rpc.call('reconsiderblock', [blockHash]);
  }

  /**
   * Mines a block with exactly the given raw transactions — how a
   * conflicting competing chain is built, since a conflicting tx cannot
   * enter via the mempool (RG-03).
   */
  async generateBlock(outputAddress: string, rawTxs: readonly string[]): Promise<string> {
    const result = asObject(
      await this.rpc.call('generateblock', [outputAddress, rawTxs]),
      'generateblock',
    );
    return asString(result['hash'], 'generateblock.hash');
  }

  /** Wallet view of a single transaction; confirmations go NEGATIVE on conflict. [pin M4] */
  async getTransaction(txid: string): Promise<{ confirmations: number }> {
    const tx = asObject(await this.rpc.call('gettransaction', [txid]), 'gettransaction');
    return { confirmations: asInteger(tx['confirmations'], 'gettransaction.confirmations') };
  }

  /** Wallet reorg-observation primitive: include_removed surfaces transactions
   *  from disconnected blocks. [pin M4] */
  async listSinceBlock(blockHash: string): Promise<{
    transactions: { txid: string; confirmations: number }[];
    removed: { txid: string }[];
  }> {
    const result = asObject(
      // [blockhash, target_confirmations, include_watchonly (deprecated), include_removed]
      await this.rpc.call('listsinceblock', [blockHash, 1, true, true]),
      'listsinceblock',
    );
    const decodeEntry = (entry: JsonValue, context: string) => {
      const record = asObject(entry, context);
      return {
        txid: asString(record['txid'], `${context}.txid`),
        confirmations: asInteger(record['confirmations'], `${context}.confirmations`),
      };
    };
    return {
      transactions: asArray(result['transactions'], 'listsinceblock.transactions').map((e, i) =>
        decodeEntry(e, `listsinceblock.transactions[${String(i)}]`),
      ),
      removed: asArray(result['removed'], 'listsinceblock.removed').map((e, i) => {
        const record = asObject(e, `listsinceblock.removed[${String(i)}]`);
        return { txid: asString(record['txid'], `listsinceblock.removed[${String(i)}].txid`) };
      }),
    };
  }

  /** One transaction paying several addresses (CF-05), explicit sat/vB feerate. */
  async sendMany(
    amounts: Readonly<Record<string, bigint>>,
    feeRateSatPerVb: number,
  ): Promise<string> {
    if (!Number.isInteger(feeRateSatPerVb) || feeRateSatPerVb <= 0) {
      throw new RangeError(
        `fee rate must be a positive integer of sat/vB: ${String(feeRateSatPerVb)}`,
      );
    }
    const decimalAmounts: Record<string, string> = {};
    for (const [address, sats] of Object.entries(amounts)) {
      decimalAmounts[address] = satsToBtc(sats);
    }
    return asString(
      await this.rpc.call('sendmany', {
        dummy: '',
        amounts: decimalAmounts,
        fee_rate: feeRateSatPerVb,
      }),
      'sendmany',
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
      const fees = asOptional(record['fees'], asObject, `${context}.fees`);
      return {
        txid: asString(record['txid'], `${context}.txid`),
        allowed: asBoolean(record['allowed'], `${context}.allowed`),
        rejectReason: asOptional(record['reject-reason'], asString, `${context}.reject-reason`),
        feeSats: fees === undefined ? undefined : asSats(fees['base'], `${context}.fees.base`),
        vsize: asOptional(record['vsize'], asInteger, `${context}.vsize`),
      };
    });
  }

  /** PSBT hand-off (M5): the library builds, the node-side wallet signs. */
  async createPsbt(
    inputs: readonly { txid: string; vout: number }[],
    outputs: Readonly<Record<string, string>>,
  ): Promise<string> {
    return asString(await this.rpc.call('createpsbt', [inputs, outputs]), 'createpsbt');
  }

  async walletProcessPsbt(psbt: string): Promise<{ psbt: string; complete: boolean }> {
    const result = asObject(await this.rpc.call('walletprocesspsbt', [psbt]), 'walletprocesspsbt');
    return {
      psbt: asString(result['psbt'], 'walletprocesspsbt.psbt'),
      complete: asBoolean(result['complete'], 'walletprocesspsbt.complete'),
    };
  }

  async finalizePsbt(psbt: string): Promise<{ hex: string; complete: boolean }> {
    const result = asObject(await this.rpc.call('finalizepsbt', [psbt]), 'finalizepsbt');
    return {
      hex: asString(result['hex'], 'finalizepsbt.hex'),
      complete: asBoolean(result['complete'], 'finalizepsbt.complete'),
    };
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
