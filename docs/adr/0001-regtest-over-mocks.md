# ADR-0001 — Regtest over mocks (and over signet/mainnet) for integration lanes

**Status:** accepted (M1) · **Owner:** qasimmahmood95

## Context

The system under test is the *integration boundary* between custody logic
and bitcoind: confirmation counting, reorg observation, rebroadcast
semantics, fee-estimator degradation. The sibling repos already cover the
other side of the line — [vaultchain](https://github.com/qasimmahmood95/vaultchain)
drives custody workflows over a *simulated* chain, reconciliation-testing
and contract-invariant-testing never touch a chain at all. Simulation was
the right tool there because the logic under test was ours. Here the
contract under test is **Bitcoin Core's actual behaviour**, and three
options exist for exercising it: mock bitcoind, use a shared public test
network (signet/testnet), or run a real bitcoind against a private chain
(regtest).

## Decision

Integration lanes run a **real bitcoind on regtest**, from a pinned Docker
image, never mocked and never patched.

- **Why not mocks:** a mock encodes our *beliefs* about bitcoind — the
  exact behaviours this repo exists to pin (mempool resurrection after
  `invalidateblock`, `estimatesmartfee`'s error payload, coinbase-maturity
  enforcement, `sendrawtransaction` rebroadcast semantics) are the things a
  mock would get subtly wrong. A characterization test against a mock has
  zero evidentiary value: it can only confirm the beliefs it was built
  from. Mocks stay allowed in the unit lane, where the code under test is
  ours, not Core's.
- **Why not signet/testnet:** shared networks produce blocks on wall-clock
  time (slow, nondeterministic), cannot be reorged on demand, and couple CI
  to a live network — all four determinism rules broken at once. Signet
  survives only as a documented, manual, local-only read-only smoke lane —
  never required, never in CI.
- **Why not mainnet:** never. No real funds exist anywhere in this system
  (hard limit 3), and no mainnet endpoint may appear in the repo.
- **Why regtest specifically:** trivial PoW mines a block in milliseconds
  *when a test asks for one* — block production becomes a fixture, not an
  event to await. `invalidateblock`/`reconsiderblock`/`generateblock` make
  reorgs three-RPC-call constructions. State dies with the container, so
  every run starts from the identical genesis. That converts the
  normally-impossible-to-reproduce failures (races, reorgs, estimator
  outages) into deterministic, CI-safe scenarios.

## Consequences

- CI needs Docker; the unit lane deliberately does not — properties and
  fixtures run anywhere.
- The image is pinned by tag **and digest** (docker-compose.yml). Core
  version bumps are deliberate: the M1/M4/M6 characterization tests fail
  loudly if a bump changes a pinned contract, which is a feature.
- Regtest quirks become first-class fixtures rather than obstacles — e.g.
  `estimatesmartfee` returning "Insufficient data or no feerate found" *is*
  scenario FE-01, so the compose file deliberately sets no `-fallbackfee`.
