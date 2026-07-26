/**
 * Exact BTC-decimal ↔ bigint-satoshi conversion.
 *
 * `number` never holds money anywhere in this repo; amounts cross the RPC
 * boundary as decimal source text and are converted here by exact string
 * parsing (ADR-0004). Anything that is not a plain decimal with at most
 * 8 fractional digits — exponents, hex, whitespace, thousands separators —
 * is rejected loudly rather than coerced.
 */

export const SATS_PER_BTC = 100_000_000n;

export class AmountFormatError extends Error {
  constructor(readonly input: string) {
    super(`not an exact BTC decimal: ${JSON.stringify(input)}`);
    this.name = 'AmountFormatError';
  }
}

const BTC_DECIMAL_RE = /^(-?)(\d+)(?:\.(\d{1,8}))?$/;

export function btcToSats(decimal: string): bigint {
  const match = BTC_DECIMAL_RE.exec(decimal);
  if (match === null) {
    throw new AmountFormatError(decimal);
  }
  const sign = match[1];
  const whole = match[2];
  const fraction = match[3] ?? '';
  if (whole === undefined) {
    throw new AmountFormatError(decimal);
  }
  const sats = BigInt(whole) * SATS_PER_BTC + BigInt(fraction.padEnd(8, '0'));
  return sign === '-' ? -sats : sats;
}

/** Renders with a fixed 8-digit fraction — the form bitcoind itself emits. */
export function satsToBtc(sats: bigint): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = (abs / SATS_PER_BTC).toString();
  const fraction = (abs % SATS_PER_BTC).toString().padStart(8, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
