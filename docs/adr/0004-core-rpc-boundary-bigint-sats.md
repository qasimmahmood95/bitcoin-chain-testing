# ADR-0004 — The core/RPC boundary, and bigint satoshis at the edge

**Status:** accepted (M1) · **Owner:** qasimmahmood95

## Context

Two facts collide at the RPC boundary:

1. bitcoind denominates amounts as **JSON numbers in BTC** with up to 8
   fractional digits (`50.00000000`, `0.1`).
2. Most 8-dp decimals have **no IEEE-754 double representation** — `0.1`
   BTC parsed by `JSON.parse` is already `0.1000000000000000055…` before
   any of our code runs. Converting that to satoshis "carefully" is float
   arithmetic on money, which this repo bans outright (`number` never holds
   money; same rule and lint as reconciliation-testing).

Separately, the confirmation state machine, derivation, tx building and fee
policy (`src/core/`, M2+) must stay exercisable by fixtures and fast-check
properties without any node.

## Decision

- **`src/core/` is pure.** No I/O, no imports from `src/rpc/`
  (lint-enforced). It consumes and produces plain data — chain events in,
  states and transactions out — so the model-based properties can drive it
  exhaustively before it ever meets a real node.
- **`src/rpc/` is a minimal, hand-rolled, typed JSON-RPC client.** No RPC
  framework dependency: the client is transport + envelope interpretation,
  small enough to read in one sitting and to trust in a test harness.
- **Amounts convert to `bigint` satoshis at this boundary, by exact
  decimal-string parsing.** Responses are parsed by a ~150-line
  number-preserving JSON parser: every number surfaces as a `RawNumber`
  token carrying its untouched source text, and per-RPC typed decoders
  convert each consumed field explicitly — BTC amounts via
  `btcToSats` (exact string → bigint), counts via checked safe-integer
  parsing. Unknown shapes fail loudly. Outbound amounts are serialized as
  decimal strings (`satsToBtc`), which Core's `AmountFromValue` accepts —
  no float ever crosses the wire in either direction.

Alternatives rejected:

- **`JSON.parse` + reviver:** the reviver receives an already-rounded
  double — too late by construction.
- **`JSON.parse` source-text access (`context.source`):** engine-version
  dependent; a determinism harness must not vary behaviour by V8 build.
- **`json-bigint`-style dependency:** coerces *all* numbers globally
  (breaking legitimate non-money floats such as `verificationprogress`),
  adds a dependency where the whole point of the hand-rolled client is a
  boundary small enough to audit.

## Consequences

- Every RPC field the harness consumes is named and decoded on purpose;
  drive-by `any` access is impossible. New scenarios must extend the typed
  wrappers — which is the point (hard limit 1: every export exists because
  a scenario consumes it).
- The parser itself is unit- and property-tested (structure parity with
  `JSON.parse`, number-text preservation), and the live payload shapes are
  pinned by the integration lane.
- ESLint bans `parseFloat`, fractional literals, `Date.now`, and
  `Math.random` in `src/**` — the boundary rule is mechanical, not
  aspirational.
