/**
 * Hand-rolled JSON parser that preserves each number's exact source text.
 *
 * bitcoind denominates amounts as JSON numbers in BTC (e.g. `50.00000000`).
 * Routing those through IEEE-754 doubles (`JSON.parse`) before converting to
 * satoshis is exactly the float-money path this repo bans: `0.1` BTC has no
 * double representation. Numbers therefore surface as {@link RawNumber}
 * tokens carrying untouched decimal source text, and typed decoders convert
 * per field — BTC amounts via exact decimal-string → bigint satoshis,
 * counts via checked integer parsing. See ADR-0004.
 */

export class RawNumber {
  constructor(readonly text: string) {}
}

export type JsonValue =
  null | boolean | string | RawNumber | JsonValue[] | { [key: string]: JsonValue };

export class JsonParseError extends Error {
  constructor(
    detail: string,
    readonly position: number,
  ) {
    super(`invalid JSON: ${detail} at position ${String(position)}`);
    this.name = 'JsonParseError';
  }
}

/**
 * Recursion depth is bounded by the engine stack (a pathological nesting
 * depth throws RangeError, not JsonParseError) — acceptable: bitcoind
 * response shapes are shallow and this parser is not exposed to attackers.
 */
export function parseJson(text: string): JsonValue {
  const parser = new Parser(text);
  const value = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.atEnd()) {
    throw new JsonParseError('trailing characters', parser.position);
  }
  return value;
}

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

class Parser {
  position = 0;

  constructor(private readonly text: string) {}

  atEnd(): boolean {
    return this.position >= this.text.length;
  }

  private peek(): string {
    return this.text.charAt(this.position);
  }

  skipWhitespace(): void {
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
        break;
      }
      this.position += 1;
    }
  }

  parseValue(): JsonValue {
    this.skipWhitespace();
    if (this.atEnd()) {
      throw new JsonParseError('unexpected end of input', this.position);
    }
    switch (this.peek()) {
      case '{':
        return this.parseObject();
      case '[':
        return this.parseArray();
      case '"':
        return this.parseString();
      case 't':
        this.expectLiteral('true');
        return true;
      case 'f':
        this.expectLiteral('false');
        return false;
      case 'n':
        this.expectLiteral('null');
        return null;
      default:
        return this.parseNumber();
    }
  }

  private parseObject(): JsonValue {
    this.position += 1; // '{'
    // Null prototype: an RPC response must not be able to smuggle keys like
    // __proto__ into harness objects.
    const result: { [key: string]: JsonValue } = Object.create(null) as {
      [key: string]: JsonValue;
    };
    this.skipWhitespace();
    if (this.peek() === '}') {
      this.position += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        throw new JsonParseError('expected string key', this.position);
      }
      const key = this.parseString();
      this.skipWhitespace();
      if (this.peek() !== ':') {
        throw new JsonParseError("expected ':'", this.position);
      }
      this.position += 1;
      result[key] = this.parseValue();
      this.skipWhitespace();
      const next = this.peek();
      if (next === ',') {
        this.position += 1;
      } else if (next === '}') {
        this.position += 1;
        return result;
      } else {
        throw new JsonParseError("expected ',' or '}'", this.position);
      }
    }
  }

  private parseArray(): JsonValue {
    this.position += 1; // '['
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.peek() === ']') {
      this.position += 1;
      return result;
    }
    for (;;) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const next = this.peek();
      if (next === ',') {
        this.position += 1;
      } else if (next === ']') {
        this.position += 1;
        return result;
      } else {
        throw new JsonParseError("expected ',' or ']'", this.position);
      }
    }
  }

  private parseString(): string {
    this.position += 1; // '"'
    let result = '';
    for (;;) {
      if (this.atEnd()) {
        throw new JsonParseError('unterminated string', this.position);
      }
      const ch = this.peek();
      if (ch === '"') {
        this.position += 1;
        return result;
      }
      if (ch === '\\') {
        this.position += 1;
        const escape = this.peek();
        if (escape === 'u') {
          const hex = this.text.slice(this.position + 1, this.position + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new JsonParseError('invalid unicode escape', this.position);
          }
          result += String.fromCharCode(Number.parseInt(hex, 16));
          this.position += 5;
        } else if (escape in ESCAPES) {
          result += ESCAPES[escape] ?? '';
          this.position += 1;
        } else {
          throw new JsonParseError('invalid escape', this.position);
        }
      } else if (ch.charCodeAt(0) < 0x20) {
        throw new JsonParseError('unescaped control character', this.position);
      } else {
        result += ch;
        this.position += 1;
      }
    }
  }

  private parseNumber(): RawNumber {
    NUMBER_RE.lastIndex = this.position;
    const match = NUMBER_RE.exec(this.text);
    if (match === null) {
      throw new JsonParseError('unexpected token', this.position);
    }
    this.position += match[0].length;
    return new RawNumber(match[0]);
  }

  private expectLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.position)) {
      throw new JsonParseError(`expected '${literal}'`, this.position);
    }
    this.position += literal.length;
  }
}
