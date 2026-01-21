# Mobile Tests

This directory contains mobile-specific test infrastructure for `@qvac/translation-nmtcpp`.

## Structure

- **integration-runtime.cjs** - Runtime loader for integration tests on mobile devices
- **integration.auto.cjs** - Auto-generated file containing test runners (DO NOT EDIT MANUALLY)

## Usage

The `integration.auto.cjs` file is automatically generated from integration tests in `test/integration/`.

To regenerate:

```bash
npm run test:mobile:generate
```

## How It Works

1. Integration tests are written in `test/integration/*.test.js` using Brittle
2. The generation script (`scripts/generate-mobile-integration-tests.js`) creates wrapper functions
3. Mobile test framework calls these wrapper functions which load the actual tests
4. Tests run identically on both mobile and desktop platforms

## Files Included in Package

Only these mobile test files are published with the package:
- `integration-runtime.cjs`
- `integration.auto.cjs`

The actual test implementations (`test/integration/*.test.js`) are not included in the published package.

