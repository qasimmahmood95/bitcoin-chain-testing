import { awaitRegtestReady, connectRegtest } from '../../src/testing/node.js';

// Health gate for the whole integration lane: bounded poll until bitcoind
// answers, then refuse anything that is not regtest (hard limit 3).
export default async function globalSetup(): Promise<void> {
  await awaitRegtestReady(connectRegtest());
}
