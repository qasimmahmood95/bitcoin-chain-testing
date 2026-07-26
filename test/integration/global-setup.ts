import { awaitRegtestReady, connectRegtest } from '../../src/testing/node.js';

// Health gate for the whole integration lane: bounded poll until bitcoind
// answers, then refuse anything that is not regtest (hard limit 3). The
// short per-call timeout keeps the gate's true worst case (~30×3s) inside
// the CI budget even against a wedged connection.
export default async function globalSetup(): Promise<void> {
  await awaitRegtestReady(connectRegtest({ timeoutMs: 2_000 }));
}
