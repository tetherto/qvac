// ESLint flat config (ESM) with strict TypeScript rules and no `any`
import tseslint from 'typescript-eslint'
import importPlugin from 'eslint-plugin-import'

export default [
  // Ignore generated output, native build artifacts, third-party sources, and lockfiles.
  {
    ignores: [
      'index.js',
      'bci.js',
      'configChecker.js',
      'addonLogging.js',
      'lib/**',
      'index.d.ts',
      'bci.d.ts',
      'configChecker.d.ts',
      'addonLogging.d.ts',
      'build/**',
      'prebuilds/**',
      'third-party/**',
      'addon/**',
      'examples/**',
      'scripts/**',
      'test/**',
      'tmp/**',
      'eslint.config.*',
      'package-lock.json'
    ]
  },

  // Type-aware recommended rules (only for TS files)
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx']
  })),

  // Project-specific rules, kept aligned with packages/sdk.
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      import: importPlugin
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: './tsconfig.json',
          alwaysTryTypes: true
        },
        node: {
          extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs']
        }
      },
      'import/extensions': ['.js', '.jsx', '.ts', '.tsx', '.mjs']
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      'import/no-unresolved': ['error', { ignore: ['^@qvac/bci-whispercpp/'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description' }
      ],
      'eol-last': ['error', 'always']
    }
  }
]
