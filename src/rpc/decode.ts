/**
 * Typed narrowing for parsed RPC JSON (ADR-0004). Every field the harness
 * consumes is decoded explicitly — BTC amounts to bigint satoshis, counts to
 * checked safe integers. Unknown or unexpected shapes fail loudly instead of
 * flowing onward as `any`.
 */

import { AmountFormatError, btcToSats } from './amount.js';
import { RawNumber, type JsonValue } from './json.js';

export class DecodeError extends Error {
  constructor(context: string, detail: string) {
    super(`${context}: ${detail}`);
    this.name = 'DecodeError';
  }
}

export function asObject(
  value: JsonValue | undefined,
  context: string,
): { [key: string]: JsonValue } {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof RawNumber
  ) {
    throw new DecodeError(context, 'expected an object');
  }
  return value;
}

export function asArray(value: JsonValue | undefined, context: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new DecodeError(context, 'expected an array');
  }
  return value;
}

export function asString(value: JsonValue | undefined, context: string): string {
  if (typeof value !== 'string') {
    throw new DecodeError(context, 'expected a string');
  }
  return value;
}

export function asBoolean(value: JsonValue | undefined, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DecodeError(context, 'expected a boolean');
  }
  return value;
}

export function asInteger(value: JsonValue | undefined, context: string): number {
  if (!(value instanceof RawNumber)) {
    throw new DecodeError(context, 'expected a number');
  }
  if (!/^-?\d+$/.test(value.text)) {
    throw new DecodeError(context, `expected an integer, got ${value.text}`);
  }
  const parsed = Number(value.text);
  if (!Number.isSafeInteger(parsed)) {
    throw new DecodeError(context, `integer out of safe range: ${value.text}`);
  }
  return parsed;
}

/** BTC-denominated JSON number → bigint satoshis, by exact decimal parsing. */
export function asSats(value: JsonValue | undefined, context: string): bigint {
  if (!(value instanceof RawNumber)) {
    throw new DecodeError(context, 'expected a number');
  }
  try {
    return btcToSats(value.text);
  } catch (error) {
    if (error instanceof AmountFormatError) {
      throw new DecodeError(context, `not an exact BTC amount: ${value.text}`);
    }
    throw error;
  }
}

export function asStringArray(value: JsonValue | undefined, context: string): string[] {
  return asArray(value, context).map((entry, index) =>
    asString(entry, `${context}[${String(index)}]`),
  );
}

export function asOptional<T>(
  value: JsonValue | undefined,
  decode: (value: JsonValue, context: string) => T,
  context: string,
): T | undefined {
  return value === undefined ? undefined : decode(value, context);
}
