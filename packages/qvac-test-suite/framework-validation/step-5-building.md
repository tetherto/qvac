# Step 5 Validation: Consumer Building (Desktop)

## What Was Built

- build:consumer:desktop CLI command
- Dependency installation (auto from package.json or manual)
- esbuild bundler integration
- Portable consumer package output

## Validation

Test that the framework can bundle source + tests into a portable consumer.

### Build Consumer

```bash
cd framework-validation
node ../framework/dist/cli/index.js build:consumer:desktop --platform macos
```

### Expected Output

```
🔨 Building desktop consumer for macos

📂 Entry point: ./tests/desktop/executor-with-handlers.js
📦 Output directory: /path/to/build/consumers/macos

📦 Installing dependencies...
   Running npm install in /path/to/build/consumers/macos...
✅ Dependencies installed

🔧 Bundling with esbuild...

✅ Consumer built successfully: /path/to/build/consumers/macos/consumer.js

📋 To run:
   node /path/to/build/consumers/macos/consumer.js --runId=<id> --mqtt-broker=<url>
```

**Note**: framework-validation/ now has package.json with mqtt dependency, mimicking a real target repo.

### Check Output

```bash
ls -la build/consumers/macos/
# Should show:
# consumer.js (bundled code)
# consumer.js.map (sourcemap)
# package.json (with dependencies)
# node_modules/ (mqtt and dependencies installed)
```

### Test Built Consumer

```bash
# Terminal 1: mosquitto -v

# Terminal 2: cd framework-validation && node ../framework/dist/cli/index.js run:producer --runId=built-test

# Terminal 3: Run built consumer
node build/consumers/macos/consumer.js --runId=built-test --mqtt-broker=mqtt://localhost:1883
```

Should execute tests using the built/bundled consumer.

## Success Criteria

- ✅ Consumer builds successfully
- ✅ Dependencies installed
- ✅ Source + tests bundled with esbuild
- ✅ Built consumer is executable
- ✅ Built consumer can connect and run tests
- ✅ Portable (can copy build/ dir and run elsewhere)

