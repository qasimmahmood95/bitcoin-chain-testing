import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.spec.ts'],
          setupFiles: ['test/setup-fast-check.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          // One node, one chain: integration files run strictly in sequence
          // (single fork) so every test observes only the chain events it
          // drove itself.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
