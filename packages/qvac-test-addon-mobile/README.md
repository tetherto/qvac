# QVAC Addon Mobile Tester

A template project for testing native addons on mobile platforms (iOS and Android). This app enables immediate on-device testing for addons during development without requiring custom example apps.


## Overview

This is a React Native + Bare runtime application that:
- Loads addon test code from the addon's `test/mobile/test.cjs` file
- Automatically initializes and runs individual test functions via RPC
- Provides isolated test execution with pass/fail reporting for each test
- Handles asset loading and management automatically
- Includes WebDriverIO e2e tests for CI/CD integration

## Features

✨ **Flexible Addon Installation**: Supports local directories, .tgz files, and published npm packages  
🧪 **Independent Test Execution**: Each test function runs in isolation with individual PASS/FAIL reporting  
📦 **Automatic Asset Management**: Handles mobile asset bundling and path resolution  
🔧 **Auto-Generated E2E Tests**: Creates WebDriverIO tests for each test function  
🚀 **Zero Configuration**: Just provide a `test/mobile/test.cjs` file and go  
📱 **Cross-Platform**: Works on both iOS and Android  
🔄 **Hot Reload Ready**: Rebuild and redeploy quickly during development  
🎤 **Pre-Test Steps**: Support for pre-test actions like microphone recording before tests run

## Architecture

```
┌─────────────────────┐
│   React Native UI   │  (app/index.js)
│   - Displays status │
│   - Shows results   │
│   - Loads assets    │
└──────────┬──────────┘
           │ RPC (bare-rpc)
           │ Commands: INIT, RUN_TEST
┌──────────▼──────────┐
│   Bare Backend      │  (backend/backend.cjs)
│   - init()          │  Static: sets dirPath & assetPaths
│   - getAssetPath()  │  Helper: resolves asset URIs
│   - testFunction1() │  ← Injected from addon's test/mobile/test.cjs
│   - testFunction2() │     (each test function runs independently)
│   - testFunctionN() │
└─────────────────────┘
```

## Prerequisites

- Node.js 18+
- For Android: Android SDK, Android Studio
- For iOS: Xcode, CocoaPods
- An addon with `test/mobile/test.cjs` file

## How It Works

1. **Build Time**: The build script extracts all `async function` declarations from your addon's `test/mobile/test.cjs` file and generates:
   - Backend code with injected test functions
   - Test configuration with function names
   - Asset manifest for file loading
   - E2E test cases for each function

2. **Runtime**: When the app launches:
   - React Native UI loads and initializes assets
   - Backend initializes with `dirPath` and asset paths
   - User triggers tests via buttons (automated tests run sequentially, manual tests run individually)
   - Results display as "testName: PASS" or "testName: FAIL"
   - Tests continue even if one fails

3. **E2E Testing**: WebDriverIO checks for PASS/FAIL text for each test function

## Quick Start

### 1. Build the Test App

From the template project root:

```bash
npm run build <addon-source> [mobile-tests-dir]
```

The build command supports multiple input formats:

**Local directory:**
```bash
npm run build ../qvac-lib-infer-llamacpp-llm
```

**Local .tgz file:**
```bash
npm run build ../qvac-llm-llamacpp-0.3.1.tgz
```

**Published npm package:**
```bash
npm run build @qvac/llm-llamacpp
```

**Published package with version:**
```bash
npm run build @qvac/llm-llamacpp@0.3.1
```

**Override mobile tests directory (bypass packaged tests):**
```bash
npm run build @qvac/llm-llamacpp@0.5.6 ./path/to/mobile/tests
```
or with a local addon:
```bash
npm run build ../qvac-lib-infer-llamacpp-llm ./path/to/mobile/tests
```
- All `.cjs` files in `./path/to/mobile/tests` are used as the mobile test source.
- If `./path/to/mobile/tests/testAssets` exists, those assets are copied into the app; otherwise no assets are bundled (empty manifest).

This script will:
- ✅ Extract test code from addon's `test/mobile/test.cjs`
- ✅ Install the addon package
- ✅ Install test dependencies (from addon's devDependencies)
- ✅ Generate `backend/backend.cjs` with injected test logic
- ✅ Generate `app/testConfig.js` with list of test functions
- ✅ Generate `app/assetManifest.js` for asset loading
- ✅ Generate `e2e/tests/app.test.js` with individual test cases
- ✅ Bundle the app using `bare-pack`

### 2. Run on Device/Simulator

#### Android
```bash
npm run android
```

#### iOS
```bash
npm run ios
```

The app will:
1. Initialize (set dirPath and load asset mappings)
2. Display a "Run Automated Tests" button for tests without pre-test requirements
3. Display individual controls for manual tests (tests requiring microphone input, etc.)
4. Run each test function independently via button press
5. Display results for each test as: "testName: PASS" or "testName: FAIL"
6. Show detailed error messages for failed tests

Each test function runs independently, so one failure doesn't stop others from running.

## Creating Tests for Your Addon

### Step 1: Create Test File

In your addon repository, create `test/mobile/test.cjs`:

```javascript
'use strict'

const YourAddon = require('@your-org/your-addon')
// Import other dependencies needed for testing

// Module-level variables (shared across tests)
let modelInstance = null

/**
 * Test 1: Load and initialize the model
 * The global variable 'dirPath' points to testAssets directory
 * The global function 'getAssetPath(filename)' resolves asset URIs
 */
async function testLoadModel() {
  try {
    console.log('Starting model load...')
    console.log('Assets directory:', dirPath)
    
    // Use getAssetPath() to get the correct path for assets
    const modelPath = getAssetPath('model.gguf')
    
    modelInstance = new YourAddon({
      modelPath: modelPath,
      // other configuration
    })
    
    await modelInstance.load()
    console.log('Model loaded successfully')
    
    return 'Model loaded successfully'
  } catch (error) {
    console.error('Load model test failed:', error)
    throw new Error(`Failed to load model: ${error.message}`)
  }
}

/**
 * Test 2: Run inference with the loaded model
 */
async function testInference() {
  try {
    if (!modelInstance) {
      throw new Error('Model not loaded - run testLoadModel first')
    }
    
    console.log('Starting model inference...')
    const testInput = 'your test input'
    const result = await modelInstance.run(testInput)
    
    // Validate output
    if (!result) {
      throw new Error('Model returned empty result')
    }
    
    console.log('Inference result:', result)
    return `Inference completed: ${result}`
  } catch (error) {
    console.error('Inference test failed:', error)
    throw new Error(`Inference failed: ${error.message}`)
  }
}

/**
 * Test 3: Cleanup and unload
 */
async function testUnloadModel() {
  try {
    if (!modelInstance) {
      throw new Error('Model not loaded')
    }
    
    console.log('Unloading model...')
    await modelInstance.unload()
    modelInstance = null
    console.log('Model unloaded successfully')
    
    return 'Model unloaded successfully'
  } catch (error) {
    console.error('Unload test failed:', error)
    throw new Error(`Failed to unload: ${error.message}`)
  }
}

// Export is optional - the build script extracts all async functions
module.exports = {
  testLoadModel,
  testInference,
  testUnloadModel
}
```

### Step 2: (Optional) Add Test Assets

If your addon requires model files or other assets, create a `test/mobile/testAssets/` folder:

```
your-addon/
├── test/
│   └── mobile/
│       ├── test.cjs
│       └── testAssets/
│           └── model.gguf
```

The build script will automatically copy `testAssets/` to the mobile app.

### Step 3: Build and Test

```bash
cd path/to/qvac-addon-mobile-tester
npm run build ../your-addon
npm run android  # or npm run ios
```

## Running E2E Tests

The template includes WebDriverIO tests that can run on physical devices or emulators.

### Prerequisites

Make sure you have:
- Android: Emulator running or device connected via ADB
- iOS: Simulator running or device connected

### Run Tests

```bash
# Android
cd e2e
npm run test:android

# iOS
cd e2e
npm run test:ios
```

### What the E2E Test Does

The test file (`e2e/tests/app.test.js`) is auto-generated and:
1. Launches the app
2. Waits for "INITIALIZED" status
3. Creates individual test cases for each test function
4. Checks for "testName: PASS" or "testName: FAIL" for each test
5. Fails if any test shows "FAIL"

The test file is regenerated every time you run `npm run build` to match your addon's test functions.

### CI/CD Integration

For AWS Device Farm or CI pipelines:

1. Build the app:
```bash
npm run build ../your-addon
npm run android  # builds APK
```

2. Upload APK to Device Farm
3. Run e2e tests against the uploaded build

## Advanced Features

### Pre-Test Steps

The mobile tester supports pre-test steps that execute before running the actual test. This is useful for:
- Recording audio from the microphone for transcription tests
- Collecting user input dynamically
- Setting up test data on-device

#### Example: Microphone Recording Test

1. **Configure the test** in `app/testConfig.js`:

```javascript
export const TEST_CONFIG = {
  'test_mic_transcription': {
    preTest: {
      type: 'recordMicrophone',
      duration: 5000  // Record for 5 seconds
    }
  }
}
```

2. **Write your test function** to accept `preTestData`:

```javascript
async function test_mic_transcription(dirPath, getAssetPath, preTestData) {
    // preTestData contains { audioData, sampleRate, format }
    const audioBuffer = Buffer.from(Float32Array.from(preTestData.audioData).buffer)
    
    // Use the recorded audio for transcription
    const model = await loadModel()
    const result = await model.transcribe(audioBuffer)
    
    return { fullText: result }
}
```

Pre-test steps are configured automatically based on test function signatures during the build process.

### Post-Test Steps

Post-test steps are handled automatically in `app/index.js` via the `handleResultData()` function. Currently supported:

- **Audio Playback**: Return `{ audioData: [...] }` from your test to play audio
- **Text Display**: Return `{ fullText: "..." }` to display transcribed text
- **Scores**: Return `{ score: 0.95 }` to show metrics

## Project Structure

```
qvac-addon-mobile-tester/
├── app/
│   ├── index.js              # Main React Native app
│   ├── assetManifest.js      # Generated: asset file mappings
│   ├── testConfig.js         # Generated: list of test functions
│   ├── hooks/
│   │   └── useWorklet.js     # Bare worklet hook for RPC
│   └── utils/
│       ├── assetLoader.js    # Asset loading utilities
│       ├── audio.js          # Audio playback utilities
│       └── preTestSteps.js   # Pre-test step execution
├── backend/
│   ├── backend.cjs           # Generated: contains injected test logic
│   ├── api.cjs               # RPC command constants
│   └── app.bundle            # Generated: bundled backend
├── e2e/
│   ├── package.json
│   └── tests/
│       ├── app.test.js       # Generated: WebDriverIO tests
│       ├── wdio.config.android.js
│       └── wdio.config.ios.js
├── scripts/
│   ├── build-test-app.js     # Main build script
│   └── bundle.sh             # Bare-pack bundling script
├── testAssets/               # Generated: copied from addon
├── package.json
└── README.md
```

## Build Script Details

The `scripts/build-test-app.js` script performs these steps:

1. **Install Addon**: Packs (if directory) and installs the addon as npm package
2. **Get Package Name**: Extracts the package name from the installed addon
3. **Read Test Code**: Reads `test/mobile/test.cjs` from node_modules
4. **Extract Logic**: Removes `module.exports` and extracts all test functions
5. **Extract Test Functions**: Identifies all `async function` declarations (except `init`)
6. **Extract Dependencies**: Parses `require()` statements to find test dependencies
7. **Install Test Dependencies**: Installs dependencies from addon's `devDependencies` or `dependencies`
8. **Generate Backend**: Creates `backend/backend.cjs` with:
   - Static `init()` function (sets global `dirPath` and `assetPaths`)
   - Helper `getAssetPath()` function for asset resolution
   - Injected test logic (all your test functions)
   - RPC request handlers (handleInit, handleRunTest)
   - Command routing (INIT, RUN_TEST)
   - Test function map for individual execution
9. **Copy Assets**: Copies `test/mobile/testAssets/` to project root if it exists
10. **Generate Asset Manifest**: Creates `app/assetManifest.js` with asset file mappings
11. **Generate Test Config**: Creates `app/testConfig.js` with list of test function names
12. **Generate E2E Tests**: Creates `e2e/tests/app.test.js` with individual test cases
13. **Bundle**: Runs `bare-pack` to create the final app bundle

## Troubleshooting

### Build fails with "Cannot find module"

**Solution**: Make sure all dependencies used in `test/mobile/test.cjs` are listed in your addon's `package.json` (either `dependencies` or `devDependencies`).

### App shows "RPC NOT WORKING"

**Solution**: The Bare worklet failed to initialize. Check:
- The bundle was created successfully (`backend/app.bundle` exists)
- No syntax errors in `backend/backend.cjs`
- Run `npm run barelog` to see Bare logs

### Model loading fails

**Solution**: Check:
- Model files are in `testAssets/` folder
- File paths in test code match the actual file locations
- Sufficient device storage/memory

### E2E test times out

**Solution**:
- Increase timeout in `e2e/tests/app.test.js`
- Check if app is actually running on device/emulator
- Look at app logs with `npm run barelog` (Android)

## Advanced Usage

### Test Execution Behavior

The app has a button-based interface for running tests:
- **Automated tests**: Run via the "Run Automated Tests" button
- **Manual tests** (tests requiring pre-test input like microphone recording): Have individual "Start Recording" / "Stop Recording" and "Run Test" buttons

There is a 3-second delay before initialization to ensure assets are loaded. To modify:

Edit `app/index.js`:
```javascript
// Delay before initialization
setTimeout(() => {
  init()
}, 3000) // Change this value
```

### Multiple Test Scenarios

Each `async function` you define in `test/mobile/test.cjs` becomes an independent test:

```javascript
// Each function runs independently and shows PASS/FAIL
async function testScenario1() {
  // Test code here
  return 'Scenario 1 completed'
}

async function testScenario2() {
  // Test code here
  return 'Scenario 2 completed'
}

async function testScenario3() {
  // Test code here
  return 'Scenario 3 completed'
}
```

Tests run in the order they are defined. If one test fails, the others will still run.

### Accessing Test Assets

Two global helpers are available for accessing test assets:

1. **`dirPath`**: The testAssets directory path
2. **`getAssetPath(filename)`**: Resolves the actual file path for an asset

```javascript
async function testLoadModel() {
  // Get the directory path
  console.log('Assets directory:', dirPath)
  
  // Get the actual path for a specific asset file
  const modelPath = getAssetPath('model.gguf')
  const configPath = getAssetPath('config.json')
  
  // Use the paths with your addon
  const model = new YourAddon({ modelPath })
  await model.load()
}
```

**Why use `getAssetPath()`?** On mobile platforms, assets are bundled into the app and may be at different locations than the project structure suggests. The `getAssetPath()` function ensures you get the correct runtime path.

### Best Practices for Test Functions

**1. Keep tests focused and granular:**
```javascript
// ✅ Good - each test has a single purpose
async function testLoadModel() { /* ... */ }
async function testInference() { /* ... */ }
async function testUnload() { /* ... */ }

// ❌ Bad - one massive test doing everything
async function testEverything() { /* load, infer, unload all in one */ }
```

**2. Use descriptive test names:**
```javascript
// ✅ Good - clear what the test does
async function testModelLoadsWithLargeContext() { /* ... */ }

// ❌ Bad - vague
async function test1() { /* ... */ }
```

**3. Return meaningful success messages:**
```javascript
// ✅ Good
return `Processed ${result.tokens} tokens in ${elapsed}ms`

// ❌ Bad
return 'ok'
```

**4. Throw descriptive errors:**
```javascript
// ✅ Good
throw new Error(`Expected 128 tokens but got ${actual}`)

// ❌ Bad
throw new Error('failed')
```

**5. Use module-level variables for shared state:**
```javascript
// ✅ Good - share instances across tests
let modelInstance = null

async function testLoad() {
  modelInstance = new Model()
  await modelInstance.load()
}

async function testInference() {
  if (!modelInstance) throw new Error('Model not loaded')
  return await modelInstance.run('test')
}
```

### Adding UI Controls

The template intentionally has minimal UI. To add buttons or controls:

1. Edit `app/index.js` to add React Native components
2. Create functions that call RPC methods (INIT, RUN_TEST)
3. Update e2e tests accordingly

Example:
```javascript
import { Button } from 'react-native'
import { RUN_TEST } from '../backend/api.cjs'

// Add a button to run a specific test
<Button 
  title="Run Test"
  onPress={() => runTest('testLoadModel')}
/>
```

## Addon Compatibility Testing

Since this repository is the base for mobile testing across all QVAC addons, we have automated compatibility checks to ensure PRs don't break existing addons.

### How It Works

1. **Addon Registry**: All compatible addons are registered in `.github/addon-registry.json`
2. **PR Checks**: When a PR is opened, the `addon-compatibility-check.yml` workflow:
   - Builds test apps for each registered addon
   - Verifies all generated files are created correctly
   - Generates native projects (expo prebuild)
   - Reports results on the PR

### Local Validation

Before submitting a PR, validate compatibility locally:

```bash
# Test all registered addons
npm run validate

# Test specific addon
npm run validate -- --addon @qvac/llm-llamacpp

# Test local addon directory
npm run validate:local ../path/to/addon
```

### Adding Addons to Registry

To register a new addon for compatibility testing, edit `.github/addon-registry.json`:

```json
{
  "name": "@qvac/your-addon",
  "repository": "tetherto/your-addon-repo",
  "branch": "main",
  "testPath": "test/mobile",
  "platforms": ["Android", "iOS"]
}
```

See [docs/ADDON_COMPATIBILITY.md](docs/ADDON_COMPATIBILITY.md) for full documentation.

## Contributing

We welcome contributions to improve this mobile testing template! 

### For Template Improvements

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. **Run compatibility validation**: `npm run validate`
5. Commit your changes: `git commit -m "Add some feature"`
6. Push to the branch: `git push origin feature/your-feature`
7. Open a Pull Request

### For Adding Addon Support

When adding support for new addons:

1. Create `test/mobile/test.cjs` in your addon repository
2. Define multiple `async function` declarations for different test scenarios
3. Use the global `dirPath` and `getAssetPath()` helpers for accessing testAssets
4. Use hardcoded test inputs (no user interaction)
5. Each test function should return a descriptive status string (e.g., "Model loaded successfully")
6. Throw descriptive errors with `Error()` constructor for failures
7. Optionally add `test/mobile/testAssets/` for model files or test data
8. Test with this template using `npm run build ../your-addon`
9. Each test function will be executed independently and show PASS/FAIL results

## Related Documentation

- [Bare Runtime](https://github.com/holepunchto/bare)
- [React Native Bare Kit](https://github.com/holepunchto/react-native-bare-kit)
- [WebDriverIO](https://webdriver.io/)

## License

Apache-2.0



