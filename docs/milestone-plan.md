# Milestone plan

Each milestone ends in a PR gated by two review passes: a **code review**
(assertion strength, determinism, scope — no bitcoind patches, no key
material, no non-regtest endpoints) and a **verification pass** (clean
checkout, stack up from scratch, suite green, falsification harness proves
no vacuous passes). Scenario IDs (`DR/CF/RG/TX/FE/BR-xx`) refer to
[`integration-scenarios.md`](integration-scenarios.md).

## M0 — Plan (this PR)

**Deliverables:** `CLAUDE.md`, this plan, the integration-scenario table.
**Exit:** reviewer (repo owner) approves scenarios, invariants, and the
state-machine/reorg policy sketch. No code.

## M1 — Harness scaffolding + ADR-0001/0004

**Deliverables:**

- `docker-compose.yml`: bitcoind regtest from a **pinned image** (exact tag
  + digest recorded; chosen at M1 from the official Bitcoin Core images),
  `txindex=1`, fixed test-only rpcauth, healthcheck on
  `getblockchaininfo`. No volume — chain state is deliberately ephemeral.
- TypeScript strict ESM scaffold: vitest `unit`/`integration` projects,
  eslint (including the no-float-money and no-wallclock rules) + prettier,
  gitleaks pre-commit + CI.
- `src/rpc/`: minimal typed JSON-RPC client, **decimal-string → bigint
  satoshis at the boundary** (no float arithmetic on amounts, ever).
- Fixtures: fresh-chain guarantee (compose down -v semantics), mine-to
  helpers, ephemeral node-side signing wallet created per run.
- Smoke + first characterization tests: node reachable; mine 101 and spend
  a coinbase (**pins the mempool maturity boundary: spend at depth 99
  rejected, 100 accepted** — the spend first confirms at depth 101);
  `estimatesmartfee` insufficient-data shape recorded.
- CI workflow: lint → typecheck → unit → integration (compose `--wait`) →
  gitleaks.
- **ADR-0001**: why regtest over mocks — and why the sibling repos'
  simulated chain (VaultChain `/simulator`) is not enough once the SUT *is*
  the chain boundary; why not signet (shared, slow, nondeterministic
  blocks) or mainnet (never) for CI.
- **ADR-0004**: core/RPC boundary; bigint satoshis at the edge.

**Exit:** CI green from a clean checkout; verification pass confirms a
second `stack:up` after `stack:down` reproduces identical genesis state.

## M2 — Derivation & watch-only descriptors (DR-01…DR-04)

**Deliverables:** `src/core/derivation` (account-level public key → ranged
receive/change addresses, mainnet + regtest); unit vectors against the
published BIP84/BIP86 test vectors (public-key side only — no xprvs in the
repo, per hard limit 2); integration parity against `deriveaddresses`;
watch-only descriptor wallet import with `getwalletinfo` proving
`private_keys_enabled=false`; cross-network guard. **Falsification harness
lands here** (`npm run falsify`, required CI job from this milestone on).

**Exit:** suite + falsify green; verification pass confirms every DR lever
goes red.

## M3 — Deposit detection & the confirmation-depth state machine (CF-01…CF-05) + ADR-0002

**Deliverables:** `src/core/confirmations` — the state machine
(`UNSEEN → SEEN_MEMPOOL → CONFIRMING(c) → CREDITED`, terminal
`CONFLICTED`), pure and event-driven; fast-check **model-based properties**
(random valid chain-event sequences vs full-history oracle recomputation);
the block-walking watcher over `src/rpc/`; integration scenarios with the
node's watch-only wallet as the second observer; the credit boundary
asserted as a triplet at `N-1 / N / N+1`; restart/re-poll idempotence.
**ADR-0002**: states, credit-at-N, credit stickiness, finality-violation
policy (alert, never silent).

**Exit:** unit properties and CF suite green; falsify red across CF levers.

## M4 — Reorg handling (RG-01…RG-05) + ADR-0003

Its own milestone, deliberately: this is the repo's reason to exist.

**Deliverables:** deterministic reorg fixtures over
`invalidateblock` / `reconsiderblock` / `generateblock`-with-raw-txs; the
two reorg flavours as distinct scenarios (tx resurrected to mempool vs tx
conflicted away); **the headline test: a deposit reorged out before
finality depth un-credits** (RG-01); re-inclusion without double-credit
(RG-02); conflicting double-spend → `CONFLICTED`, never credited (RG-03);
deeper-than-finality reorg → sticky credit + `FINALITY_VIOLATION` alert
(RG-04); chain flapping A→B→A converges to the no-reorg state (RG-05).
Characterization tests pin `listsinceblock include_removed` and negative
`confirmations` semantics before the tracker relies on them.
**ADR-0003**: single-node reorg simulation, the mempool-resurrection
nuance, why not a two-node partition.

**Exit:** RG suite green on `main`; falsify proves each RG test fails when
its lever is pulled; verification pass replays RG-01 twice from clean state
with identical results.

## M5 — Transaction construction & fee policy (TX-01…TX-03, FE-01…FE-02)

**Deliverables:** `src/core/txbuild` — deterministic input selection over
credited (≥N-conf) watched UTXOs with in-flight reservation, change to the
correct internal-chain index, exact value conservation in bigint sats;
`src/core/feepolicy` — clamped feerate selection with a typed
estimator-unavailable fallback (regtest's `estimatesmartfee` failure is the
fixture, not an obstacle); dust handling (fold to fee, never emit);
`testmempoolaccept` as the node-side acceptance oracle; signing delegated
to the ephemeral node wallet (PSBT hand-off — the library never sees a
key). fast-check properties: value conservation and feerate-clamp bounds
for arbitrary estimator outputs.

**Exit:** TX/FE suites green; falsify red across levers.

## M6 — Broadcast idempotency & conflict surface (BR-01…BR-03)

**Deliverables:** characterization tests pinning `sendrawtransaction`
rebroadcast semantics (already-in-mempool ×k, already-mined at 1..N conf),
then the accounting invariants on top: exactly one mempool entry, exactly
one ledger record, watched UTXO spent once, state byte-identical after
retries; conflicting-input broadcast surfaces a typed rejection and a
terminal failed state, never a stuck in-flight one.

**Exit:** BR suite green; falsify red; verification pass runs the
rebroadcast volley twice from clean state.

## M7 — Planted defects, red CI, README

**Deliverables:** three `defect/*` branches, each `main` plus **one
commit** containing one plausible bug, CI red by design, linked from the
README:

| Branch | The plausible bug | Caught by (observed, not asserted) |
|---|---|---|
| `defect/credit-at-one-conf` | "confirmed means confirmed" — credits on first confirmation | 6 unit pins (boundary triplet, CF-03 oracle) + **CF-02, RG-01, RG-02, RG-03, RG-05** |
| `defect/reorg-uncredit-missed` | block-disconnect bookkeeping skipped for deposits "never counted" — pending state never reverts | 2 unit pins (demotion, CF-03 oracle) + **RG-01, RG-05** |
| `defect/rebroadcast-double-credit` | dedup keyed on the observation event instead of the outpoint | unit re-sighting pin + **RG-06** (added in M7: the defect exposed that no integration scenario exercised the re-sighting path) |

Plus: final README in the sibling style (thesis, run-it-yourself, the
headline reorg walk-through with real red-run output, scope & non-goals),
signet-lane documentation (local, manual, read-only), evidence links.

**Exit:** verification subagent, from a clean checkout, confirms each
defect branch's designated test genuinely fails — RG-01 verified twice —
and `main` is fully green. Owner review of the README closes the repo.
