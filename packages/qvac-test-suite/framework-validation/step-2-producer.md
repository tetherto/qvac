# Step 2 Validation: Producer + CLI

## What Was Built

- Producer CLI command that loads external tests
- BatchOrchestrator adapted to accept test array
- CLI infrastructure with commander.js

## Validation

**Note**: This step requires MQTT broker running. You'll need to start it manually.

### Terminal 1: Start MQTT Broker

```bash
mosquitto -v
```

### Terminal 2: Run Producer

```bash
cd framework-validation
node ../framework/dist/cli/index.js run:producer --runId=test-producer
```

### Expected Output

```
🚀 Starting QVAC Test Producer

📂 Loading config from: /path/to/framework-validation
✅ Config loaded

📋 Loading tests from: ./tests
✅ Loaded 2 tests

🔨 Building test queue...

📦 Built 2 tests:
   - sample: 1 tests
   - uncategorized: 1 tests

✅ Producer connected to MQTT broker
🔑 Run ID: test-producer
🌐 Wildcard consumers: disabled
📡 Subscribed to coordination topics
🚀 Batch orchestration started
📋 Total tests: 2
⏳ Waiting for consumers to register...
```

Producer should stay running, waiting for consumers to connect.

Press Ctrl+C to stop when done validating.

## Success Criteria

- ✅ Config loaded from external directory
- ✅ Tests loaded from testDir
- ✅ Test queue built from TestDefinition array
- ✅ MQTT connection established
- ✅ Producer waiting for consumers
