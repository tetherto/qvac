// ESLint flat config (ESM) with strict TypeScript rules and no `any`.
// Kept aligned with packages/embed-llamacpp.
import tseslint from 'typescript-eslint'
import importPlugin from 'eslint-plugin-import'

export default [
  // Generated output, native build artifacts, and JS covered by lunte/prettier.
  {
    ignores: [
      'index.js',
      'index.d.ts',
      'process.js',
      'process.d.ts',
      'process-internal.js',
      'process-internal.d.ts',
      'process-runner.js',
      'process-runner.d.ts',
      'binding.js',
      'build/**',
      'prebuilds/**',
      'addon/**',
      'scripts/**',
      'test/**',
      'eslint.config.*',
      'package-lock.json'
    ]
  },

  // Type-aware recommended rules (only for TS files)
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts']
  })),

  {
    files: ['**/*.ts'],
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
          extensions: ['.ts', '.js', '.mjs']
        }
      },
      'import/extensions': ['.js', '.ts', '.mjs']
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
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
