import * as fc from 'fast-check';

// Determinism policy: CI pins FC_SEED=20260726; locally fast-check picks a
// seed and prints it with any failure, so every red run is replayable.
const seed = process.env['FC_SEED'];
if (seed !== undefined) {
  fc.configureGlobal({ seed: Number.parseInt(seed, 10) });
}
