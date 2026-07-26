# ADR-0003 — Deterministic reorg simulation on a single node

**Status:** accepted (M4) · **Owner:** qasimmahmood95

## Context

Reorgs are the reason this repo exists (RG-01…RG-05), and they are exactly
the events a test suite can never wait for on a shared network. The
simulation has to produce, on demand: a deposit reorged out but still
valid (demoted), a deposit re-included at a new height, a deposit killed
by a competing double-spend, a reorg deeper than finality, and tip
flapping. Two candidate mechanisms: a two-node partition (mine divergent
chains, reconnect, let consensus pick), or a single node driven with
`invalidateblock` / `reconsiderblock` / `generateblock`.

## Decision

**Single node, three RPCs.**

- `invalidateblock <hash>` disconnects that block and its descendants —
  the reorg's "abandon this branch" half. Any block mined afterwards
  extends the surviving branch, so a competing chain needs no second
  miner and no race.
- **The nuance the whole milestone turns on:** transactions from
  disconnected blocks **re-enter the mempool** while still valid.
  "Reorged out" therefore means *demoted to 0-conf*, not *gone* (RG-01) —
  and a naive competing chain mined with `generatetoaddress` would
  silently re-include the resurrected deposit. Empty competing blocks are
  mined with `generateblock <addr> '[]'`; re-inclusion (RG-02) is then an
  explicit choice, not an accident.
- A deposit dies for good only when the competing chain **spends its
  input**. Since Core 29 the mempool is unconditionally full-RBF, so a
  *well-funded* conflict would simply replace the deposit — transaction
  replacement, not the mined-double-spend attack RG-03 pins. The spec
  therefore builds an **underpaying** conflict: the mempool refuses it
  with `insufficient fee, rejecting replacement` (pinned in RG-03), and
  it is mined **directly** via `generateblock` with the raw transaction —
  blocks are not bound by mempool policy. That asymmetry (a block may
  carry what the mempool refuses) is exactly the custody-relevant attack
  shape.
- `reconsiderblock` re-validates an abandoned branch, giving A→B→A
  flapping (RG-05) as three deterministic calls: reconsider A, invalidate
  B's first block, done.
- Wallet-side observation is pinned alongside: `listsinceblock
  include_removed` surfaces disconnected transactions in `removed`, and
  `gettransaction` reports **negative confirmations** equal to minus the
  conflicting transaction's depth (RG-03). The tracker is built against
  these pinned behaviours, not the documentation.

**Why not a two-node partition:** it tests the same observer logic while
adding nondeterminism (P2P relay timing, which branch wins, when
reconnection converges), a second container, and orchestration that can
flake — all cost, no added coverage for the system under test, which
watches *one* node's view of the chain. Multi-peer behaviour (eclipse,
relay policy divergence) is a non-goal recorded in CLAUDE.md.

## Consequences

- Every reorg scenario is a three-to-five-RPC fixture, fast enough for CI
  and reproducible byte-for-byte (the verification gate replays RG-01
  twice from clean state and expects identical outcomes).
- The watcher must genuinely walk headers to the fork point (single-node
  reorgs exercise it identically to network ones — connect/disconnect
  events are the node's own reorg machinery).
- `invalidateblock` marks a branch invalid until `reconsiderblock`; specs
  that flap must clean up their own invalidations, or later specs would
  inherit a poisoned chain — each RG spec ends on the active chain it
  asserted.
- Suite-wide invariant that keeps one shared node safe under all this
  surgery: no spec ever asserts global mempool, height, or wallet state —
  only views filtered to its own txids and watched addresses.
