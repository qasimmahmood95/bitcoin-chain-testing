# bitcoin-chain-testing

Deterministic integration tests for the **custodian ↔ bitcoind boundary**.
Custody systems don't run the chain — they watch it and talk to it, and
that boundary is where the hard QA problems live: confirmation races,
reorgs, fee-estimator degradation, rebroadcast ambiguity. On regtest,
block production is driven by the tests, so a reorg is not a rare event to
wait for but a three-RPC-call fixture.

**Status: M1 — harness scaffolding.** The plan and full scenario table:
[docs/milestone-plan.md](docs/milestone-plan.md) ·
[docs/integration-scenarios.md](docs/integration-scenarios.md) ·
ADRs in [docs/adr/](docs/adr/).

## Run it

Requires Node ≥ 22, Docker with the compose plugin, and
[gitleaks](https://github.com/gitleaks/gitleaks) (pre-commit gate, wired to
`core.hooksPath` by `npm install`).

```bash
npm install
npm run stack:up          # bitcoind regtest (pinned image), health-gated
npm run test:unit         # pure library lane — no Docker needed
npm run test:integration  # scenario suite against the regtest node
npm run stack:down        # clean slate — chain state dies with the container
```

No private keys exist in this repo or in the library under test — signing
is delegated to an ephemeral wallet inside the disposable regtest
container. No mainnet anything, ever.

The full README (thesis, headline reorg walk-through with real red-run
evidence, scope & non-goals) lands with M7.
