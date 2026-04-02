# SDK Tests

SDK dogfooding tests built on top of `@qvac/test-suite`.

## Layout

- `tests/test-definitions.ts` - full SDK test catalog
- `tests/desktop/consumer.ts` - desktop consumer with broad handler coverage
- `tests/mobile/consumer.ts` - mobile consumer entry point
- `qvac-test.config.js` - producer and consumer framework config
- `metro.config.js` - SDK-specific Metro config for mobile consumers

## Install

From `packages/sdk/tests-qvac`:

```bash
npm i
npm run build
```

## Local iOS Run

This flow builds the generated mobile consumer app, installs it on a physical iPhone, then runs the producer locally.

### Prerequisites

- Xcode installed
- iPhone connected and trusted by Xcode
- Apple signing configured for the generated app
- `ios-deploy` installed for CLI install:

```bash
brew install ios-deploy
```

### 1. Export MQTT settings

Use values reachable from the iPhone on the same local network. In most local runs, `MQTT_HOST` should be the IP of the machine running the producer and broker.

```bash
export MQTT_PROTOCOL=ws
export MQTT_HOST=<broker-ip>
export MQTT_PORT=8080
export MQTT_PATH=/mqtt
```

If your broker requires auth, also export:

```bash
export MQTT_USERNAME=...
export MQTT_PASSWORD=...
```

### 2. Build the generated iOS consumer

```bash
npx qvac-test build:consumer:ios --runId <run-id> --config .
```

### 3. Build the Xcode app for the device

Before building, open the generated workspace in Xcode and verify signing:

- open `build/consumers/ios/ios/QVACTestConsumer.xcworkspace`
- select the `QVACTestConsumer` target
- set a valid Apple Team under Signing & Capabilities
- if signing fails, change the bundle identifier to a unique value for your Apple account

After signing is configured, you can build from Xcode UI or from the command line below.

```bash
cd build/consumers/ios/ios

xcodebuild \
  -workspace QVACTestConsumer.xcworkspace \
  -scheme QVACTestConsumer \
  -configuration Release \
  -destination 'id=<device-udid>'
```

### 4. Install the app on the iPhone

```bash
ios-deploy \
  --bundle ~/Library/Developer/Xcode/DerivedData/<derived-data-dir>/Build/Products/Release-iphoneos/QVACTestConsumer.app
```

### 5. Start the producer

Run this in a terminal that still has the same `MQTT_*` exports:

```bash
npx qvac-test run:producer --runId <run-id> --config .
```

### 6. Start tests from the phone

Open the installed app on the iPhone and start the automated run. The producer should detect the mobile consumer over MQTT and begin assigning tests.

## Notes

- The generated mobile app uses the local checked-out SDK from `packages/sdk`.
- The iOS build currently uses the generated Xcode scheme `QVACTestConsumer`.
- The Metro config includes explicit audio asset extensions required by the mobile test assets.
