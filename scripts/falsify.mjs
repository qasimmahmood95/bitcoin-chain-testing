// Falsification harness (hard limit 5: no vacuous passes).
//
// Every documented FALSIFY=<id> lever activates exactly one sabotage inside
// a spec or fixture (grep for falsifyActive('<id>')). This runner executes
// each targeted spec with its lever pulled and requires it to go RED — a
// lever whose spec stays green is a test that cannot fail, and the harness
// itself exits nonzero.
//
//   npm run falsify              # all levers (integration levers need the stack up)
//   npm run falsify -- DR-01 …   # a subset
import { spawnSync } from 'node:child_process';

const LEVERS = [
  // ── M1 ───────────────────────────────────────────────────────────────
  {
    id: 'AMOUNT',
    project: 'unit',
    spec: 'test/unit/amount.spec.ts',
    sabotage: 'truncating float conversion replaces exact decimal parsing',
  },
  {
    id: 'JSON',
    project: 'unit',
    spec: 'test/unit/json.spec.ts',
    sabotage: 'numbers routed through IEEE-754 like a naive parser',
  },
  {
    id: 'ENVELOPE',
    project: 'unit',
    spec: 'test/unit/rpc-envelope.spec.ts',
    sabotage: 'RPC error envelopes swallowed to null',
  },
  {
    id: 'SMOKE',
    project: 'integration',
    spec: 'test/integration/m1-smoke.spec.ts',
    sabotage: 'pinned genesis constant flipped',
  },
  {
    id: 'MATURITY',
    project: 'integration',
    spec: 'test/integration/m1-coinbase-maturity.spec.ts',
    sabotage: 'one extra block mined before the boundary asserts',
  },
  {
    id: 'FEE-PIN',
    project: 'integration',
    spec: 'test/integration/m1-fee-estimator.spec.ts',
    sabotage: 'pinned estimator error string flipped',
  },
  // ── M2 ───────────────────────────────────────────────────────────────
  {
    id: 'DR-01',
    project: 'unit',
    spec: 'test/unit/derivation-vectors.spec.ts',
    sabotage: 'receive/change branch swapped',
  },
  {
    id: 'DR-04',
    project: 'unit',
    spec: 'test/unit/derivation-network-guard.spec.ts',
    sabotage: 'mismatch scenarios given matching material — guard never fires',
  },
  {
    id: 'DR-02',
    project: 'integration',
    spec: 'test/integration/dr-02-derivation-parity.spec.ts',
    sabotage: 'library range shifted by one',
  },
  {
    id: 'DR-03',
    project: 'integration',
    spec: 'test/integration/dr-03-watchonly-detection.spec.ts',
    sabotage: 'descriptor import skipped',
  },
  // ── M3 ───────────────────────────────────────────────────────────────
  {
    id: 'CF-SM',
    project: 'unit',
    spec: 'test/unit/cf-state-machine.spec.ts',
    sabotage: 'fixture finality depth lowered by one',
  },
  {
    id: 'CF-03',
    project: 'unit',
    spec: 'test/unit/cf-03-model-based.spec.ts',
    sabotage: 'oracle confirmation count off by one block',
  },
  {
    id: 'CF-01',
    project: 'integration',
    spec: 'test/integration/cf-01-mempool-pending.spec.ts',
    sabotage: 'mempool sightings counted as credited',
  },
  {
    id: 'CF-02',
    project: 'integration',
    spec: 'test/integration/cf-02-credit-boundary.spec.ts',
    sabotage: 'tracker finality depth lowered by one',
  },
  {
    id: 'CF-04',
    project: 'integration',
    spec: 'test/integration/cf-04-restart-idempotence.spec.ts',
    sabotage: 'checkpoint dropped — restart re-walks the whole window',
  },
  {
    id: 'CF-05',
    project: 'integration',
    spec: 'test/integration/cf-05-outpoint-aggregation.spec.ts',
    sabotage: 'records keyed by txid instead of outpoint',
  },
  // ── M4 ───────────────────────────────────────────────────────────────
  {
    id: 'RG-01',
    project: 'integration',
    spec: 'test/integration/rg-01-reorged-out-uncredits.spec.ts',
    sabotage: 'the reorg is suppressed — nothing to un-credit',
  },
  {
    id: 'RG-02',
    project: 'integration',
    spec: 'test/integration/rg-02-reinclusion-single-credit.spec.ts',
    sabotage: 'stale pre-reorg inclusion height demanded',
  },
  {
    id: 'RG-03',
    project: 'integration',
    spec: 'test/integration/rg-03-conflicting-spend.spec.ts',
    sabotage: 'conflicted viewed as still-pending',
  },
  {
    id: 'RG-04',
    project: 'integration',
    spec: 'test/integration/rg-04-finality-violation.spec.ts',
    sabotage: 'finality-violation alert dropped',
  },
  {
    id: 'RG-05',
    project: 'integration',
    spec: 'test/integration/rg-05-chain-flapping.spec.ts',
    sabotage: 'window replayed without checkpoint dedup',
  },
];

const requested = process.argv.slice(2);
const unknown = requested.filter((id) => !LEVERS.some((lever) => lever.id === id));
if (unknown.length > 0) {
  console.error(`unknown lever id(s): ${unknown.join(', ')}`);
  process.exit(2);
}
const selected = requested.length > 0 ? LEVERS.filter((l) => requested.includes(l.id)) : LEVERS;

if (selected.some((l) => l.project === 'integration')) {
  const probe = spawnSync(
    'node',
    [
      '-e',
      `
    const url = process.env.BITCOIND_RPC_URL ?? 'http://127.0.0.1:18443';
    fetch(url, { method: 'POST', signal: AbortSignal.timeout(2000) }).then(() => process.exit(0), () => process.exit(1));
  `,
    ],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) {
    console.error('integration levers need the regtest stack: npm run stack:up');
    process.exit(2);
  }
}

const vacuous = [];
for (const lever of selected) {
  const result = spawnSync('npx', ['vitest', 'run', '--project', lever.project, lever.spec], {
    encoding: 'utf8',
    env: { ...process.env, FALSIFY: lever.id },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const specRan = output.includes('Test Files');
  const wentRed = result.status !== 0 && specRan;
  console.log(
    `${lever.id.padEnd(9)} ${wentRed ? 'RED (good)' : 'STAYED GREEN — VACUOUS'}  · ${lever.sabotage}`,
  );
  if (!wentRed) {
    vacuous.push(lever.id);
    console.error(output.split('\n').slice(-25).join('\n'));
  }
}

if (vacuous.length > 0) {
  console.error(`\nvacuous levers (their tests cannot fail): ${vacuous.join(', ')}`);
  process.exit(1);
}
console.log(`\nall ${String(selected.length)} levers went red — no vacuous passes.`);
