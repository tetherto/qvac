// ESLint flat config for authored TypeScript. Generated JavaScript and
// declarations are validated through check:generated instead.
import tseslint from 'typescript-eslint'
import importPlugin from 'eslint-plugin-import'

export default [
  {
    ignores: [
      'index.js',
      'index.d.ts',
      'src/**/*.js',
      'src/**/*.d.ts',
      'test/**',
      'eslint.config.*',
      'package-lock.json'
    ]
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx']
  })),
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
      'import/no-unresolved': 'error',
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
