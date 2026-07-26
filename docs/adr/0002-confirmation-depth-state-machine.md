# ADR-0002 — The confirmation-depth state machine

**Status:** accepted (M3) · **Owner:** qasimmahmood95

## Context

A custodian credits a deposit only after the chain has buried it deep
enough that reversal is economically implausible. Everything hard about
that sentence lives at the boundaries: what counts as "deep enough", what
happens while a deposit is shallower, what happens when the chain *un*-buries
it, and how the answer stays correct across restarts and re-polls. The
sibling repos taught the discipline (state the invariant, drive the failure
mode); this ADR fixes the machine those invariants run on.

## Decision

### States and events

```text
              mempool sighting            connect (block includes tx)
   UNSEEN ───────────────────▶ SEEN_MEMPOOL ─────────────────▶ CONFIRMING(c)
     │                              ▲                              │
     │ connect (never seen          │ disconnect (uncredited:      │ c ≥ N
     │  in mempool first)           │  demoted, not gone)          ▼
     └─────────────▶ CONFIRMING ────┘                          CREDITED  (sticky)
                                                                   │
   conflict (double-spend of the deposit's input)                  │ disconnect/conflict
   SEEN_MEMPOOL | CONFIRMING ──────▶ CONFLICTED (terminal)         ▼
                                                          FINALITY_VIOLATION alert
```

- **UNSEEN** is implicit (no record). A record is born from a mempool
  sighting or directly from a block connect.
- **Confirmations** are `tip − inclusionHeight + 1`; a mempool-only
  deposit has 0 and can never credit, no matter how many blocks are mined
  past it (CF-01).
- **Credit fires exactly at `c ≥ N`** (finality depth, default 6, always a
  parameter) during a connect, and **latches**: `creditedAtHeight` is set
  once and never cleared, and the `credited` tracker event is emitted at
  most once per outpoint — across restarts, replays, and reorgs (CF-02,
  CF-04).
- **Identity is the outpoint** (`txid:vout`), never the txid — one
  transaction can fund several watched addresses, one address can be funded
  several times (CF-05).

### Reorg policies (exercised live in M4)

- **Disconnect of an uncredited deposit → SEEN_MEMPOOL.** Disconnected
  transactions re-enter the node's mempool while still valid: "reorged
  out" means *demoted*, not *gone* (RG-01). The deposit dies only when a
  competing chain spends its input — the `conflict` event → **CONFLICTED**,
  terminal, never credited (RG-03).
- **Disconnect that reaches a CREDITED deposit → sticky credit +
  `FINALITY_VIOLATION`.** Once the custodian has credited, the books have
  moved; silently un-crediting is a clawback the ledger downstream cannot
  see. The machine keeps the credit and raises an alert — a human decision,
  loudly requested, never a silent state flip (RG-04). The same policy
  answers a conflict against a credited deposit.

### Discipline

- **Pure and event-driven.** `applyChainEvent(state, event) → {state,
  events}` — no I/O, no clocks, no RPC imports. The block-walking watcher
  (`src/watcher/`) is the only component that talks to bitcoind, and it
  feeds the machine an *ordered* event stream: connects ascend one height
  at a time, disconnects descend from the tip.
- **Malformed sequences throw** (`ChainEventError`) — a connect at the
  wrong height or a disconnect of a non-tip block means the feed itself is
  corrupt, and corrupt feeds must crash the harness, not corrupt
  accounting.
- **Checkpointing** (CF-04): a JSON-safe snapshot (bigint satoshis as
  decimal strings) plus the watcher's processed-chain map. A restarted
  watcher re-emits nothing for work already done; dropping the checkpoint
  is the falsification lever that proves the double-credit hazard is real.
- **Verification order**: fast-check model-based properties first — random
  valid event sequences vs a naive full-history oracle recomputation
  (CF-03) — then the live scenarios with the node's watch-only wallet as
  an independent second observer. Two observers, one chain; drift fails a
  test rather than passing silently.

## Consequences

- M4's reorg scenarios are configuration, not new machinery: RG-01…RG-05
  drive exactly the disconnect/conflict paths fixed here.
- The credited latch means accounting downstream can treat `credited`
  events as an append-only ledger feed.
- `FINALITY_VIOLATION` is deliberately *not* auto-resolved; the harness
  asserts it fires and asserts the balance did not move (RG-04) — policy
  beyond that is out of scope for a test harness.
