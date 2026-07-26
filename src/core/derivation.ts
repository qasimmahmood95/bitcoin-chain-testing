/**
 * Watch-only address derivation from account-level public keys (M2).
 *
 * The custodian stance, in code: this library only ever holds public key
 * material. Parsing rejects private-versioned extended keys outright
 * (hard limit 2), rejects keys encoded for the wrong network (DR-04 —
 * cross-network confusion burns funds), and derivation is pure — no I/O,
 * no RPC imports (ADR-0004). The node's `deriveaddresses` is the parity
 * oracle (DR-02): two implementations, one descriptor, byte-equal output.
 */

import { BIP32Factory, type BIP32Interface } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import bs58check from 'bs58check';
import { initEccLib, networks, payments } from 'bitcoinjs-lib';

initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

export type Network = 'mainnet' | 'regtest';
export type ScriptType = 'p2wpkh' | 'p2tr';
export type Branch = 'receive' | 'change';

/** Malformed or unusable account key material. */
export class AccountKeyError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'AccountKeyError';
  }
}

/** Private key material offered to a watch-only library (hard limit 2). */
export class PrivateKeyMaterialError extends AccountKeyError {
  constructor() {
    super('private extended key rejected — this library is watch-only and never holds keys');
    this.name = 'PrivateKeyMaterialError';
  }
}

/** Key encoded for one network fed to a library configured for another. */
export class NetworkMismatchError extends AccountKeyError {
  constructor(keyNetwork: string, expected: Network) {
    super(
      `extended key is encoded for ${keyNetwork} but the library is configured for ${expected}`,
    );
    this.name = 'NetworkMismatchError';
  }
}

/** SLIP-132 prefix promises one script type, configuration expects another. */
export class ScriptTypeMismatchError extends AccountKeyError {
  constructor(implied: ScriptType, expected: ScriptType) {
    super(`extended key prefix implies ${implied} but the library is configured for ${expected}`);
    this.name = 'ScriptTypeMismatchError';
  }
}

/** Address belongs to a different network than the one configured. */
export class AddressNetworkError extends Error {
  constructor(address: string, expected: Network) {
    super(`address ${address} is not a ${expected} address`);
    this.name = 'AddressNetworkError';
  }
}

interface VersionInfo {
  readonly network: 'mainnet' | 'test';
  readonly scriptHint: ScriptType | null;
  readonly isPrivate: boolean;
}

/** BIP32 + SLIP-132 extended-key version bytes. Regtest uses the test encodings. */
const KEY_VERSIONS: Readonly<Record<string, VersionInfo>> = {
  '0488b21e': { network: 'mainnet', scriptHint: null, isPrivate: false }, // xpub
  '0488ade4': { network: 'mainnet', scriptHint: null, isPrivate: true }, // xprv
  '04b24746': { network: 'mainnet', scriptHint: 'p2wpkh', isPrivate: false }, // zpub
  '04b2430c': { network: 'mainnet', scriptHint: 'p2wpkh', isPrivate: true }, // zprv
  '043587cf': { network: 'test', scriptHint: null, isPrivate: false }, // tpub
  '04358394': { network: 'test', scriptHint: null, isPrivate: true }, // tprv
  '045f1cf6': { network: 'test', scriptHint: 'p2wpkh', isPrivate: false }, // vpub
  '045f18bc': { network: 'test', scriptHint: 'p2wpkh', isPrivate: true }, // vprv
};

const CANONICAL_PUBLIC_VERSION: Readonly<Record<'mainnet' | 'test', string>> = {
  mainnet: '0488b21e', // xpub
  test: '043587cf', // tpub
};

const BIP32_NETWORK = {
  mainnet: { wif: 0x80, bip32: { public: 0x0488b21e, private: 0x0488ade4 } },
  regtest: { wif: 0xef, bip32: { public: 0x043587cf, private: 0x04358394 } },
} as const;

const BITCOINJS_NETWORK = {
  mainnet: networks.bitcoin,
  regtest: networks.regtest,
} as const;

export interface WatchAccount {
  readonly network: Network;
  readonly scriptType: ScriptType;
  /** Canonical xpub/tpub re-encoding — the only form Core descriptors accept. */
  readonly canonicalKey: string;
  readonly node: BIP32Interface;
}

export interface ExpectedAccount {
  readonly network: Network;
  readonly scriptType: ScriptType;
}

const EXTENDED_KEY_LENGTH = 78;
const ACCOUNT_DEPTH = 3;

export function parseAccountPublicKey(encoded: string, expected: ExpectedAccount): WatchAccount {
  let payload: Uint8Array;
  try {
    payload = bs58check.decode(encoded);
  } catch {
    throw new AccountKeyError('not a base58check-encoded extended key');
  }
  if (payload.length !== EXTENDED_KEY_LENGTH) {
    throw new AccountKeyError(
      `extended key payload is ${String(payload.length)} bytes, expected ${String(EXTENDED_KEY_LENGTH)}`,
    );
  }
  const version = Buffer.from(payload.subarray(0, 4)).toString('hex');
  const info = KEY_VERSIONS[version];
  if (info === undefined) {
    throw new AccountKeyError(`unknown extended-key version 0x${version}`);
  }
  if (info.isPrivate) {
    throw new PrivateKeyMaterialError();
  }
  const expectedEncoding = expected.network === 'mainnet' ? 'mainnet' : 'test';
  if (info.network !== expectedEncoding) {
    throw new NetworkMismatchError(info.network, expected.network);
  }
  if (info.scriptHint !== null && info.scriptHint !== expected.scriptType) {
    throw new ScriptTypeMismatchError(info.scriptHint, expected.scriptType);
  }

  const canonical = Buffer.concat([
    Buffer.from(CANONICAL_PUBLIC_VERSION[expectedEncoding], 'hex'),
    payload.subarray(4),
  ]);
  const canonicalKey = bs58check.encode(canonical);
  const node = bip32.fromBase58(canonicalKey, BIP32_NETWORK[expected.network]);
  if (node.depth !== ACCOUNT_DEPTH) {
    throw new AccountKeyError(
      `expected an account-level key (depth ${String(ACCOUNT_DEPTH)}), got depth ${String(node.depth)}`,
    );
  }
  return { network: expected.network, scriptType: expected.scriptType, canonicalKey, node };
}

const BRANCH_INDEX: Readonly<Record<Branch, number>> = { receive: 0, change: 1 };

export function deriveAddress(account: WatchAccount, branch: Branch, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new RangeError(`derivation index out of non-hardened range: ${String(index)}`);
  }
  const child = account.node.derive(BRANCH_INDEX[branch]).derive(index);
  const pubkey = Buffer.from(child.publicKey);
  const network = BITCOINJS_NETWORK[account.network];
  const address =
    account.scriptType === 'p2wpkh'
      ? payments.p2wpkh({ pubkey, network }).address
      : payments.p2tr({ internalPubkey: pubkey.subarray(1, 33), network }).address;
  if (address === undefined) {
    throw new AccountKeyError('address derivation produced no address');
  }
  return address;
}

/** Ranged descriptor for one branch — the exact string handed to the node (DR-02/DR-03). */
export function accountDescriptor(account: WatchAccount, branch: Branch): string {
  const wrapper = account.scriptType === 'p2wpkh' ? 'wpkh' : 'tr';
  return `${wrapper}(${account.canonicalKey}/${String(BRANCH_INDEX[branch])}/*)`;
}

/**
 * Guard against cross-network address confusion (DR-04): a bech32 address
 * is accepted only when its HRP matches the configured network — never
 * silently re-encoded.
 */
export function assertAddressNetwork(address: string, network: Network): void {
  const lower = address.toLowerCase();
  const expectedHrp = network === 'mainnet' ? 'bc1' : 'bcrt1';
  if (!lower.startsWith(expectedHrp)) {
    throw new AddressNetworkError(address, network);
  }
}
