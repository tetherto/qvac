# @tetherto/qvac-test-suite

Generic distributed testing framework for multi-platform execution with GitHub Actions integration.

## Features

- **Multi-platform**: Desktop (macOS/Windows/Linux) and Mobile (iOS/Android)
- **Distributed**: MQTT-based producer/consumer orchestration
- **Type-safe**: Full TypeScript with Zod validation
- **Flexible**: Works for API, SDK, database, or integration testing
- **CI/CD**: GitHub Actions workflows with PR comments

## Installation

```bash
npm install @tetherto/qvac-test-suite
```

## Quick Start

### 1. Define Tests

```typescript
// tests/test-definitions.ts
import type { TestDefinition } from '@tetherto/qvac-test-suite';

export const myTest: TestDefinition = {
  testId: 'api-create-user',
  params: { name: 'John', email: 'john@example.com' },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'api', estimatedDurationMs: 5000 }
};

export const tests = [myTest];
```

### 2. Create Executor

```typescript
// tests/desktop/executors/api-executor.ts
import { createUser } from '../../../src/api'; // Your code
import { ValidationHelpers, type TestResult } from '@tetherto/qvac-test-suite';
import { myTest } from '../../test-definitions.ts';

export class ApiExecutor {
  pattern = /^api-/;
  
  handlers = {
    [myTest.testId]: this.createUser
  };
  
  async execute(testId, context, params, expectation) {
    const handler = this.handlers[testId];
    if (handler) return await handler.call(this, params, expectation);
    return { passed: false, output: 'Unknown test' };
  }
  
  async createUser(params, expectation) {
    const userId = await createUser(params.name, params.email);
    return ValidationHelpers.validate(userId, expectation);
  }
}
```

### 3. Configure

```typescript
// qvac-test.config.js
export default {
  brokerUrl: 'mqtt://localhost:1883',
  testDir: './tests',
  consumers: {
    desktop: {
      platforms: ['macos'],
      entry: './tests/desktop/consumer.ts',
      include: ['./src/**', './tests/**'],
      dependencies: 'auto'
    }
  }
};
```

### 4. Build & Run

```bash
# Build consumer
qvac-test build:consumer:desktop

# Terminal 1: Start MQTT broker
mosquitto -v

# Terminal 2: Start producer
qvac-test run:producer --runId=test-123

# Terminal 3: Start consumer
node build/consumers/desktop/consumer.js --runId=test-123
```

## Commands

### Building

```bash
# Build desktop consumer
qvac-test build:consumer:desktop [--platform macos]

# Build mobile consumers
qvac-test build:consumer:ios
qvac-test build:consumer:android
```

### Running

```bash
# Run producer
qvac-test run:producer [--runId=<id>] [--filter=<category>]

# Run consumer
qvac-test run:consumer:desktop --runId=<id>
```

### Reports

```bash
# Compare results
qvac-test report:compare \
  --baseline baseline.json \
  --current current.json \
  --output comparison.json

# Format to markdown
qvac-test report:format \
  --input comparison.json \
  --format markdown \
  --output comment.md
```

## Configuration

### MQTT Authentication

```javascript
// qvac-test.config.js
export default {
  mqtt: {
    broker: {
      protocol: 'mqtts',                  // or { env: 'MQTT_PROTOCOL' }
      host: { env: 'MQTT_HOST' },
      port: 8883,
    },
    username: { env: 'MQTT_USERNAME' },
    password: { env: 'MQTT_PASSWORD' },
    rejectUnauthorized: false,            // Optional: disable cert validation
  },
  testDir: './tests',
  consumers: { /* ... */ },
};
```

Framework loads `.env` files automatically. For GitHub Actions, set env vars in workflow.

## Publishing

To publish a new version:

```bash
cd framework
npm version patch  # or minor/major
npm run build
npm publish
```

Requires `NPM_TOKEN` environment variable for GitHub Packages authentication.

## License

Proprietary - Tether

