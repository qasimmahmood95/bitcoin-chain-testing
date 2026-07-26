# The signet lane (manual, local, read-only)

Regtest is the only network this repo tests on
([ADR-0001](adr/0001-regtest-over-mocks.md)). Signet exists here as a
**documented manual smoke lane** and nothing more:

- **Never in CI.** No workflow references signet; CI never touches a live
  network. The lane is run by a human, locally, on purpose.
- **Read-only.** Derive addresses, walk blocks, observe confirmations.
  No broadcasting, no wallet with keys, no funds — signet coins are
  worthless but the discipline is the point.
- **Never required.** Nothing in the suite depends on it, and no scenario
  ID is assigned to it. It is a sanity check that the RPC client and the
  block-walking watcher survive a chain this repo did not mine.
- **Mainnet never**, on any lane, in any form.

## Why it exists at all

Regtest is a controlled environment: blocks arrive when a test asks for
them, the mempool holds only what the test put there, and every reorg is
one the test caused. That control is exactly what makes the failure modes
reproducible — and exactly what a live network does not give you. The
signet lane answers one narrow question a regtest suite structurally
cannot: *does the watcher's fork-point walk behave against blocks produced
by someone else, at a cadence nobody controls?*

It is a smoke check, not a test suite. If it disagrees with regtest, the
regtest scenario is the one to fix.

## Running it

Signet needs a node this repo does not ship. Point the client at your own
signet bitcoind (`-signet -txindex=1`), then drive it from a Node REPL or
a scratch script:

```bash
# your own node, outside this repo's docker compose
bitcoind -signet -txindex=1 -rpcuser=<user> -rpcpassword=<password>
```

```ts
import { BitcoindRpc } from './src/rpc/bitcoind.js';
import { JsonRpcClient } from './src/rpc/client.js';
import { ChainWatcher } from './src/watcher/watcher.js';

const node = new BitcoindRpc(
  new JsonRpcClient({ url: 'http://127.0.0.1:38332', username: '<user>', password: '<password>' }),
);

// Read-only observation: watch an address you derived, poll, print.
const watcher = await ChainWatcher.create(node, new Set(['<tb1…address>']), 6);
console.log(await watcher.poll(), watcher.state.tipHeight);
```

Note the network guard: `deriveAddress` and `assertAddressNetwork` are
configured for regtest HRP (`bcrt`) in this repo's fixtures. Deriving
signet addresses (`tb`) means constructing the account key with signet
parameters explicitly — the guard exists precisely so cross-network
material cannot be silently re-encoded (DR-04).

## What is deliberately absent

No signet fixtures, no signet CI job, no signet credentials in the repo,
no faucet automation, and no scenario that depends on a chain this repo
does not control. Determinism is the product; the signet lane is a
courtesy check that runs when a human decides to run it.
