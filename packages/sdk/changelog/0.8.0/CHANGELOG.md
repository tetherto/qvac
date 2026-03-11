# SDK v0.8.0

## Summary
Added pivot translation support for Bergamot models, enabling two-step translations through an intermediate language.

## Features
- **Pivot Translation Support**: Added support for pivot translations in Bergamot engine, allowing translation between language pairs without direct models by using English as an intermediate language
- **Enhanced Model Registration Logging**: Improved logging for pivot translations to show both primary and pivot model names

## Changes

### feat: sdk pivot support
- Added pivot model name extraction and passing through the model loading pipeline
- Updated model registration to display both model names for pivot translations
- Modified logging output to show format like "(Spanish to Italian via English to Italian)"

## Technical Details
- Updated `loadModelServerParamsSchema` to include optional `pivotModelName` field
- Modified `registerModel` function to accept and use `pivotModelName` parameter
- Enhanced logging in `model-registry.ts` to display pivot model information
- Added pivot model name extraction using `modelInputToNameSchema` in load-model handler

## Dependencies
No dependency changes in this release.