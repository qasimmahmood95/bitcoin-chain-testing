/**
 * Falsification levers (hard limit 5: no vacuous passes). `FALSIFY=<id>`
 * activates exactly one documented sabotage inside a spec or fixture; the
 * harness (`npm run falsify`, scripts/falsify.mjs) runs every lever and
 * requires the targeted spec to go red. A lever that stays green is itself
 * a failure — the test it targets cannot fail and must not merge.
 */

export function falsifyActive(id: string): boolean {
  return process.env['FALSIFY'] === id;
}
