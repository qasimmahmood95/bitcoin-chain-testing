# bitcoin-chain-testing

Deterministic integration tests for the **custodian ↔ bitcoind boundary**.

Custody systems don't run the chain — they *watch* it and *talk* to it, and
that boundary is where the hard QA problems live: confirmation races,
reorgs, fee-estimator degradation, rebroadcast ambiguity. These are the
failures that are famously impossible to reproduce on demand, which is
exactly why they reach production.

On **regtest they stop being rare**. Block production is driven by the
tests, so a reorg is not an event to wait for but a three-RPC-call fixture:
`invalidateblock`, mine a competing chain, poll. Every scenario in this
repo drives the chain explicitly and asserts against a node that is
genuinely mining, genuinely reorging, and genuinely rejecting.

**22 integration scenarios · 53 unit tests · 31 falsification levers · 3
planted defects with red CI.** Bitcoin Core enters only as a pinned Docker
image ([`31.1@sha256:da25ce…`](docker-compose.yml)) and is never patched,
forked, or mocked.

---

## The headline: a reorg that un-credits a deposit

[`test/integration/rg-01-reorged-out-uncredits.spec.ts`](test/integration/rg-01-reorged-out-uncredits.spec.ts)

A deposit lands, confirms three times, and the custodian is watching it
mature toward its 6-confirmation credit threshold. Then the block
containing it is orphaned. The invariant: **the tracker must walk the
deposit backwards**, and it must never have credited it.

```ts
const txid = await signing.sendToAddress(address, DEPOSIT_SATS, 25);
await watcher.poll();                       // SEEN_MEMPOOL
await mineToWallet(node, signing, 3);
await watcher.poll();                       // CONFIRMING, 3 confs, inclusion at H

await node.invalidateBlock(included.inclusion.blockHash);   // the reorg
for (let i = 0; i < 4; i += 1) {
  await node.generateBlock(minerAddress, []); // competing chain, deposit excluded
}
await watcher.poll();

expect(record.state).toBe('SEEN_MEMPOOL');   // demoted, not gone
expect(record.inclusion).toBeNull();
expect(record.creditedAtHeight).toBeNull();
expect(confirmationsOf(record, watcher.state.tipHeight)).toBe(0);
expect(allEvents.filter((e) => e.kind === 'credited')).toHaveLength(0);
```

Three things make this test worth more than its length:

**1. "Reorged out" ≠ "gone."** When `invalidateblock` disconnects a block,
its transactions **re-enter the mempool** if they are still valid. A
tracker that deletes the deposit is as wrong as one that keeps crediting
it. The deposit is *demoted* to `SEEN_MEMPOOL` — still real, still
pending, zero confirmations. A deposit only dies for good when the
competing chain **double-spends its input**, which is a separate scenario
([RG-03](test/integration/rg-03-conflicting-spend.spec.ts)) with a
separate terminal state. Confusing these two is a live-incident classic;
here they are two tests with two different expected outcomes.

**2. Two independent observers must agree.** Our block-walking watcher
says `SEEN_MEMPOOL` / 0 confirmations. The node's own **watch-only
descriptor wallet** — which shares no code with our tracker — is asked the
same question via `listsinceblock … include_removed`, and must report the
transaction as `removed` *and* back among transactions at 0 confirmations.
Drift between the two fails the test rather than passing silently.

**3. The competing chain is mined empty on purpose.**
`generateblock(address, [])` mines blocks with *chosen* transactions —
here, none. `generatetoaddress` would re-mine the resurrected deposit
straight back in and the test would assert nothing.

The credit rule this protects is
[ADR-0002](docs/adr/0002-confirmation-depth-state-machine.md): credit
latches exactly once at `N` confirmations, and once credited it is
**sticky** — a deeper reorg raises a `FINALITY_VIOLATION` alert rather
than silently clawing money back
([RG-04](test/integration/rg-04-finality-violation.spec.ts)). Silent
clawback is how a custodian's ledger and the chain diverge without anyone
noticing.

---

## Proving the tests can fail

A test suite that has never been seen to fail is decoration. Two
mechanisms keep every assertion honest.

### Falsification levers — `npm run falsify`

Every scenario ships with a documented sabotage. `FALSIFY=<id>` breaks the
invariant that scenario exists to protect, and the harness asserts the
spec goes **red**:

```
$ npm run falsify
RG-01     RED (good)  · the reorg is suppressed — nothing to un-credit
CF-02     RED (good)  · credit threshold lowered to N−1
TX-03     RED (good)  · dust threshold zeroed — sub-dust change emitted
BR-01     RED (good)  · a record annotation per broadcast attempt
…
all 31 levers went red — no vacuous passes.
```

A lever that fails to turn its spec red is reported as **vacuous** and the
job fails. `falsify` is a required CI job. This gate has already earned
its keep: a code review found a `TX-03` lever whose arithmetic left it
inert — the sabotage ran and the test still passed — and it was fixed
before merge.

### Planted defects — red CI, on purpose

Three branches each carry `main` plus **one commit** containing a
plausible bug: the kind that survives code review because the reasoning
sounds right. Their CI runs are red by design, and the failing runs are
the evidence:

| Branch | The plausible bug | What went red |
|---|---|---|
| [`defect/credit-at-one-conf`](https://github.com/qasimmahmood95/bitcoin-chain-testing/tree/defect/credit-at-one-conf) | "confirmed means confirmed" — credit fires on the first confirmation instead of at `N` | [run ↗](https://github.com/qasimmahmood95/bitcoin-chain-testing/actions/runs/30214559571) — 6 unit pins (boundary triplet, CF-03 oracle) **and** CF-02, RG-01, RG-02, RG-03, RG-05 |
| [`defect/reorg-uncredit-missed`](https://github.com/qasimmahmood95/bitcoin-chain-testing/tree/defect/reorg-uncredit-missed) | disconnect bookkeeping skipped for deposits "nobody has been credited for" — pending state never reverts | [run ↗](https://github.com/qasimmahmood95/bitcoin-chain-testing/actions/runs/30214560145) — 2 unit pins **and** RG-01, RG-05 |
| [`defect/rebroadcast-double-credit`](https://github.com/qasimmahmood95/bitcoin-chain-testing/tree/defect/rebroadcast-double-credit) | dedup keyed on the observation event instead of the outpoint — a re-sighting resets the record and clears the credit latch | [run ↗](https://github.com/qasimmahmood95/bitcoin-chain-testing/actions/runs/30214560931) — the unit re-sighting pin **and** RG-06 |

The third one is the interesting one. It was caught by a unit pin but by **no
integration scenario**, because every existing spec polls while the deposit is
still in the mempool — so the watcher's txid dedup meant the re-sighting path
was never exercised against a live node. The planted defect found a hole in the
suite. [RG-06](test/integration/rg-06-resurrected-resighting.spec.ts) closes it:
a deposit first seen *on-chain*, reorged out, met again in the mempool, and
mined past `N` a second time — credited exactly once. That scenario is why
planting defects is worth the effort: it tests the tests.

Read the commit messages: each one argues for itself. *"A deposit that is
in a block is confirmed."* *"A deposit still confirming has not been
credited to anyone, so a disconnect has nothing to revert."* *"The watcher
already dedups mempool sightings by txid."* Every one of them passes lint
and typecheck cleanly. Only the tests object.

---

## Run it

Requires Node ≥ 22, Docker with the compose plugin, and
[gitleaks](https://github.com/gitleaks/gitleaks) (pre-commit gate, wired
to `core.hooksPath` by `npm install`).

```bash
npm install
npm run stack:up          # bitcoind regtest (pinned image), health-gated
npm run test:unit         # pure library lane — no Docker needed
npm run test:integration  # 22 scenarios against the regtest node
npm run falsify           # every documented lever must turn a test red
npm run stack:down        # clean slate — chain state dies with the container
```

The whole CI pipeline — lint → typecheck → unit → integration → falsify →
gitleaks — budgets **≤ ~5 minutes**. Regtest mining is milliseconds;
determinism is never traded for speed.

## What's here

```text
src/core/     pure library — no I/O, cannot import src/rpc/
              derivation · confirmation state machine · tx builder ·
              fee policy · broadcast classifier
src/rpc/      typed JSON-RPC client (number-preserving parser,
              decimal→bigint satoshis at the edge)
src/watcher/  block-walking watcher: polls, finds the fork point, feeds
              ordered connect/disconnect events to the state machine
src/testing/  fixtures, bounded polling, falsification switches
test/unit/    core against vectors and fast-check properties — no Docker
test/integration/  the scenario suite: DR · CF · RG · TX · FE · BR
docs/adr/     decision records
```

Scenario IDs by group (some are proven in the unit lane rather than
against the node, so these do not sum to the 22 integration spec files):

| Group | Scenarios | What it pins |
|---|---|---|
| **DR** | 4 | Address derivation from **account-level public keys** only; parity against the node's own `deriveaddresses`; watch-only descriptor import; cross-network rejection |
| **CF** | 5 | Confirmation depth: pending at 0-conf, credit exactly at `N` (asserted as a triplet `N−1 / N / N+1`), restart idempotence, per-outpoint aggregation |
| **RG** | 6 | Reorgs: un-credit, re-inclusion without double credit, conflicting spend as terminal, finality violation, chain flapping, resurrection re-sighting |
| **TX** | 3 | Value conservation to the satoshi against the node's own fee accounting; depth and in-flight reservation guards; dust folding |
| **FE** | 2 | The estimator that never answers (regtest returns an error payload by design) and the fee clamp |
| **BR** | 3 | Rebroadcast is free while unconfirmed; "already mined" is terminal success; conflicting broadcast is typed and terminal |

Node behaviours the suite depends on are **characterization-pinned**
rather than assumed — coinbase maturity at the mempool boundary,
`listsinceblock`'s `removed` semantics, full-RBF replacement refusal
(`insufficient fee, rejecting replacement`), `sendrawtransaction`'s error
codes (`-25` / `-26` / `-27`). A Core version bump that changes any of
them fails loudly instead of quietly invalidating a test's premise.

## Design decisions

- [ADR-0001](docs/adr/0001-regtest-over-mocks.md) — why a real node on
  regtest, over mocks and over signet/mainnet
- [ADR-0002](docs/adr/0002-confirmation-depth-state-machine.md) — the
  confirmation-depth state machine: credit-at-`N`, sticky credit, finality
  violations
- [ADR-0003](docs/adr/0003-reorg-simulation.md) — single-node reorgs via
  `invalidateblock`, the mempool-resurrection nuance, why not a two-node
  partition
- [ADR-0004](docs/adr/0004-core-rpc-boundary-bigint-sats.md) — the
  core/RPC boundary and bigint satoshis at the edge

Full scenario table: [docs/integration-scenarios.md](docs/integration-scenarios.md) ·
milestone history: [docs/milestone-plan.md](docs/milestone-plan.md)

## Scope, and what this deliberately is not

**No private key material exists in this repo.** Not even published
test-vector xprvs. Derivation is verified from account-level *public* keys
(zpub/xpub) — the watch-only custodian stance. Scenarios that need
signatures delegate to an ephemeral bitcoind wallet created fresh inside
the disposable container; the library never sees a key. gitleaks enforces
this on every commit and in CI.

**Regtest only.** Signet exists as a documented, manual, local-only
read-only lane ([docs/signet-lane.md](docs/signet-lane.md)) and is never
required and never in CI. **Mainnet never** — no mainnet endpoint,
address, or config appears anywhere. No real funds exist anywhere in this
system.

**Determinism is enforced mechanically.** No `Date.now`, `Math.random`,
`parseFloat`, or fractional literals in library code — ESLint fails the
build. All randomness flows through seeded fast-check (`FC_SEED=20260726`
pinned in CI); failing runs print their seed. Polling always carries an
explicit bounded budget; bare sleeps are never used as synchronization.
`number` never holds money anywhere in this repo.

**Non-goals, chosen deliberately:** no ZMQ push (ordering is
nondeterministic and buys no coverage — polling RPC only); no wallet
software or product surface; no two-node network partition (single-node
`invalidateblock` reorgs are deterministic and sufficient — ADR-0003); no
mainnet or funded-network lane of any kind. The library under test is
deliberately minimal: every exported function exists because a scenario
consumes it.

---

Sibling repos, same discipline, different layer:
[vaultchain](https://github.com/qasimmahmood95/vaultchain) (custody
workflows over a simulated chain) ·
[reconciliation-testing](https://github.com/qasimmahmood95/reconciliation-testing)
(fast-check properties over a ledger) ·
[contract-invariant-testing](https://github.com/qasimmahmood95/contract-invariant-testing)
(stateful invariants on a custody contract). This repo closes the gap none
of them touch: **an actual chain.**
