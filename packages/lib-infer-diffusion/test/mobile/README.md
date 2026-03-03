# Mobile Testing for Stable Diffusion Addon

This directory contains the mobile test configuration for the `@qvac/diffusion-cpp` addon.

> **Note**: This test directory is included in the published npm package to support the mobile testing framework. These test files are NOT part of the public API.

## Test Structure

- `integration-runtime.cjs` - Runtime for executing integration tests on mobile
- `integration.auto.cjs` - Auto-generated file from `npm run test:mobile:generate`
- `testAssets/` - Directory for model files and test data

## Running the Test

From the mobile tester app root:

```bash
npm run build ../lib-infer-diffusion
npm run android
npm run ios
```

## Regenerating Mobile Tests

```bash
npm run test:mobile:generate
npm run test:mobile:validate
```
