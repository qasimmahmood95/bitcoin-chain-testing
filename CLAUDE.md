# bitcoin-chain-testing

Integration test harness for the **custodian ↔ bitcoind boundary**. The
thesis: Bitcoin custody systems do not run the chain — they *watch* it and
*talk* to it, and that integration boundary is where the hard QA problems
live: confirmation races, reorgs, fee-estimator degradation, rebroadcast
ambiguity. **Regtest makes the normally-impossible-to-reproduce failures
deterministic and CI-safe**: block production is driven by the tests, so a
reorg is not a rare event to wait for but a three-RPC-call fixture.

Direct sibling of
[vaultchain](https://github.com/qasimmahmood95/vaultchain) (custody workflows
over a *simulated* chain),
[reconciliation-testing](https://github.com/qasimmahmood95/reconciliation-testing)
(fast-check properties over a ledger), and
[contract-invariant-testing](https://github.com/qasimmahmood95/contract-invariant-testing)
(stateful invariants on a custody contract). This repo closes the one gap in
that portfolio: **nothing else touches an actual chain.** Same discipline
throughout — state the invariants a custodian depends on, drive the failure
modes deterministically, and prove every test can fail.

## Hard limits (non-negotiable)

1. **Test code and harness only — plus one deliberately minimal watcher
   core.** bitcoind enters only as a **pinned Docker image** and is never
   patched, forked, or (in integration lanes) mocked. The code under test —
   derivation, confirmation tracking, tx construction, fee policy — is a
   small library that exists to make integration failures assertable; every
   exported function exists because a scenario consumes it. No wallet
   software, no product.
2. **No private key material in the repo, ever.** Not even published
   test-vector xprvs: derivation is verified from **account-level public
   keys** (zpub/xpub — exactly the watch-only custodian stance). Integration
   tests that need signatures delegate to an **ephemeral bitcoind regtest
   wallet created fresh per run inside the container**; the library never
   sees a private key. gitleaks enforces; a reviewer finding key material is
   an automatic block.
3. **Regtest only for tests and CI.** Signet is allowed strictly as a
   **documented, manual, local-only lane** (read-only smoke; never required,
   never in CI). Mainnet never — no mainnet endpoint, address, or config may
   appear anywhere in the repo. No real funds exist anywhere in this system.
4. **Determinism.** Block production happens only when a test calls for it.
   No wall-clock, no unseeded randomness (`FC_SEED=20260726` pinned in CI),
   no ZMQ push (polling RPC only — push ordering is nondeterministic and
   buys no coverage; recorded as a non-goal). CI never touches a live
   network.
5. **No vacuous passes.** Every scenario has a documented *falsification
   lever* (`FALSIFY=<id>` harness sabotage or a `defect/*` branch) and must
   be shown to fail when its invariant is deliberately broken. A test that
   cannot fail must not merge.

## System-under-test facts (Bitcoin Core regtest, 2026-07-26)

Facts the design leans on. Where marked **[pin]**, the exact behaviour is
deliberately *not assumed*: an M1/M4/M6 **characterization test** pins it,
so a Core version bump that changes the contract fails loudly.

- Regtest: trivial PoW, blocks minable on demand via `generatetoaddress` /
  `generateblock`; bech32 HRP is `bcrt`. The chain is ephemeral — state
  dies with the container, so every run starts from genesis.
- **Coinbase maturity is 100 blocks**, evaluated against the *next* block
  (mempool acceptance passes `nSpendHeight = tip+1`): a coinbase spend
  enters the mempool once the coinbase has 100 confirmations and first
  *confirms* at depth 101. Funding fixtures mine 101 blocks before first
  spend. [pin: M1 asserts the mempool boundary as a triplet — spend at
  depth 99 rejected, 100 accepted, 101 accepted]
- **`invalidateblock` / `reconsiderblock`** allow single-node deterministic
  reorgs: invalidate a block, mine a competing chain, optionally
  reconsider to flap back. **Nuance the whole reorg milestone turns on:**
  transactions from disconnected blocks **re-enter the mempool** when still
  valid — so "reorged out" ≠ "gone". A deposit only vanishes for good when
  the competing chain **conflicts** with it (double-spends its input).
  Both flavours are first-class scenarios (RG-01 vs RG-03).
- **`generateblock` accepts explicitly chosen raw transactions**, which is
  how a conflicting competing chain is constructed deterministically — a
  conflicting tx cannot enter via the mempool (`txn-mempool-conflict`), so
  it is mined directly. [pin: M4]
- **`estimatesmartfee` on regtest returns an error payload** ("Insufficient
  data or no feerate found") — there is no fee history. This is not a
  nuisance to configure away but a **first-class scenario** (FE-01): the
  estimator-unavailable path is one a real custodian must survive. [pin: M5]
- **Descriptor wallets**: `createwallet` with `disable_private_keys=true`,
  `importdescriptors` with a checksum from `getdescriptorinfo`;
  `deriveaddresses` derives from a descriptor over a range — the parity
  oracle for our library's derivation (DR-02).
- Reorg observation primitives: `listsinceblock` with `include_removed`, and
  per-tx `confirmations` (negative indicates conflict). Exact contracts
  [pin: M4] — the tracker is built against the pinned behaviour, not the
  docs.
- `sendrawtransaction` rebroadcast semantics (already-in-mempool,
  already-mined) are [pin: M6] — BR-01/BR-02 are characterization tests
  first, accounting-invariant tests second.
- RPC amounts are JSON numbers denominated in BTC. The RPC layer converts
  to **bigint satoshis at the boundary** via exact decimal-string parsing —
  never float arithmetic. `number` never holds money anywhere in this repo
  (same rule, same lint enforcement as reconciliation-testing).

## Architecture stance

```text
src/core/     pure library — no I/O, no imports from src/rpc/
              derivation · confirmation state machine · tx builder · fee policy
src/rpc/      thin typed JSON-RPC client for bitcoind (decimal→bigint at edge)
src/watcher/  block-walking watcher: polls the node, feeds ordered chain
              events to the pure state machine (imports core + rpc)
src/testing/  fast-check arbitraries + fixtures (chain-event sequences)
test/unit/    core against fixtures and properties — no Docker needed
test/integration/  drives regtest via docker compose; scenario IDs DR/CF/RG/TX/FE/BR
docs/adr/     decision records
```

- **The core is pure and fixture-testable**; the confirmation-depth state
  machine is exercised by fast-check *model-based* properties (random valid
  chain-event sequences vs an oracle recomputation from scratch) before it
  ever meets a real node.
- **Dual observation.** The watcher walks blocks itself (poll
  `getbestblockhash`, find the fork point via headers, feed
  connect/disconnect events to the state machine). The node's **watch-only
  descriptor wallet is an independent oracle**: integration scenarios assert
  our tracker's view *agrees with* the wallet's view. Two observers, one
  chain — drift fails a test rather than passing silently.
- **Finality depth `N` is a parameter** (default 6), and every
  confirmation-boundary assertion is a triplet at `N-1 / N / N+1`.

## Conventions

- **TypeScript strict ESM**; **vitest** with two projects: `unit` (no
  Docker) and `integration` (compose-gated). bitcoinjs-lib + bip32 for
  derivation and tx construction; the JSON-RPC client is minimal and
  hand-rolled (typed, decimal-exact — ADR-0004).
- **Determinism policy.** No `Date.now`, `Math.random`, `parseFloat`, or
  fractional literals in library code (ESLint-enforced). All randomness via
  seeded fast-check; failing runs print their seed; CI pins
  `FC_SEED=20260726`. Polling with explicit bounded budgets, never bare
  sleeps as synchronization.
- **Test documentation.** Every spec carries a structured header comment:
  (1) the chain events driven, (2) the invariant asserted, (3) the custody
  risk it maps to, (4) the falsification lever. Scenario IDs trace to
  [docs/integration-scenarios.md](docs/integration-scenarios.md).
- **Conventional commits** (`feat:`, `test:`, `docs:`, `ci:`, `chore:`).
- **ADRs** in `docs/adr/NNNN-*.md`. Required minimum: **0001** why regtest
  over mocks (and over signet/mainnet — and why the sibling repos' simulated
  chain is not enough here); **0002** the confirmation-depth state machine
  (states, credit-at-N, stickiness of credit, finality-violation policy);
  **0003** the reorg-simulation approach (single-node
  `invalidateblock`/`generateblock` as primary; the mempool-resurrection
  nuance; why not a two-node partition); **0004** the core/RPC boundary and
  bigint-satoshis-at-the-edge.
- **gitleaks** as pre-commit hook (`.githooks/`) and as a required CI job.

## Commands (once scaffolded — M1)

```bash
npm run stack:up        # bitcoind regtest via docker compose (pinned image), health-gated
npm run test:unit       # core library: fixtures + properties, no Docker
npm run test:integration# full scenario suite against regtest
npm run falsify         # falsification harness: every FALSIFY=<id> lever goes red
npm run stack:down      # clean slate — regtest state dies with the container
```

## Subagent protocol

- **Code-review subagent** before every milestone PR: weak or tautological
  assertions, determinism violations, unbounded polling, float-money leaks,
  and scope violations (any bitcoind patching, any private key material, any
  non-regtest endpoint = automatic block).
- **Verification subagent** before every milestone PR, from a **clean
  checkout**: `docker compose down -v` first, stack up from scratch, full
  suite green, falsification harness confirms every lever goes red. From M7
  on it additionally checks out each `defect/*` branch and confirms the
  planted defect's test **genuinely fails** — especially the reorg
  un-credit test (RG-01), which is the repo's headline. A defect a test
  fails to catch blocks the PR.

## CI

GitHub Actions: `lint` → `typecheck` → `unit` (no services) →
`integration` (compose up bitcoind `--wait`, health-gated, suite, teardown)
→ `falsify` (required from M2) → `gitleaks` (required always). Budget for
the whole pipeline ≤ ~5 minutes — regtest mining is milliseconds, and the
suite must stay fast enough that determinism is never traded for speed.
`defect/*` branches run the standard suite and are **red by design**; the
linked failing runs are README headline artifacts.

## Merge protocol

Milestone PRs are one per milestone, merged with a merge commit (never
squash — the conventional-commit history is part of the portfolio).
Self-merge is **not yet authorized for this repo**: the owner
(qasimmahmood95) merges after review, unless the standing "check and merge
yourself" instruction recorded in resilience-testing (2026-07-18) is
explicitly extended here. If extended, the conditions carry over unchanged:
both subagent gates passed, CI green on the head commit, no unresolved
review comments.
