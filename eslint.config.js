import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  // Determinism policy (CLAUDE.md): library code may not read wall-clocks,
  // draw unseeded randomness, or touch float money in any form.
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: 'No wall-clock in library code (determinism policy).',
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'No wall-clock in library code (determinism policy).',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'No unseeded randomness in library code (determinism policy).',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'No float parsing — amounts are bigint satoshis (ADR-0004).',
        },
        {
          selector: "MemberExpression[object.name='Number'][property.name='parseFloat']",
          message: 'No float parsing — amounts are bigint satoshis (ADR-0004).',
        },
        {
          // All fractional spellings: 1.5, .5, 5., 1.5e3, 1.E-3 …
          selector: 'Literal[raw=/^[0-9]*\\.[0-9]*([eE][+-]?[0-9]+)?$/]',
          message: 'No fractional literals in library code — money is bigint satoshis (ADR-0004).',
        },
      ],
    },
  },
  // Purity: src/core never touches I/O or the RPC layer (ADR-0004).
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/rpc/**'], message: 'src/core is pure — no RPC imports (ADR-0004).' },
          ],
        },
      ],
    },
  },
  prettier,
);
