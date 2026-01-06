# SDK Tests

Real SDK tests using the QVAC test framework (dogfooding).

## Structure

- `tests/test-definitions.js` - Test specifications
- `tests/desktop/consumer.js` - Consumer entry point
- `tests/desktop/executors/` - Test execution handlers by category
- `qvac-test.config.js` - Framework configuration
- `package.json` - SDK dependency

## Usage

```bash
# Install SDK
npm install

# Build consumer
cd sdk-tests
node ../framework/dist/cli/index.js build:consumer:desktop --platform macos

# Run tests
# Terminal 1: mosquitto -v
# Terminal 2: node ../framework/dist/cli/index.js run:producer --runId=sdk-test
# Terminal 3: node ../build/consumers/macos/consumer.js --runId=sdk-test --mqtt-broker=mqtt://localhost:1883

# Filter to run subset (by category or testId prefix):
# node ../framework/dist/cli/index.js run:producer --runId=sdk-test --filter=error
```

## Current Tests

- `model-load-llm` - Load LLM model
- `completion-streaming` - Streaming completion test

More tests will be added after validating these work.
