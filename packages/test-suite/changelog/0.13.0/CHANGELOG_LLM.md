# QVAC Test Suite v0.13.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.13.0

External consumers can now be clients that are not driven over stdin — an app on a phone, for example. They talk to the producer over MQTT directly, get a prepare step that runs before the producer's registration window opens, and each one gets its own `run:local:<name>` command.

---

## New APIs

### External consumers in MQTT mode

`consumers.external` already accepted `mode: 'mqtt'`, but the framework rejected it at startup, so a client that cannot be driven over stdin had no way to run. It now works: the framework starts the client with the run in its environment — `QVAC_RUN_ID`, `QVAC_TEST_PLATFORM` and the `QVAC_MQTT_*` connection settings — and the client speaks the consumer protocol itself.

```js
// qvac-test.config.js
consumers: {
  external: [
    {
      name: 'kotlin-android',
      platform: 'kotlin-android',
      mode: 'mqtt',
      prepare: { interpreter: 'node', args: ['runners/kotlin/scripts/device.mjs', 'prepare'] },
      interpreter: 'node',
      args: ['runners/kotlin/scripts/device.mjs', 'run']
    }
  ]
}
```

### A prepare step that runs before the producer starts

Building and installing an app does not fit in the producer's 30-second registration window. An external entry can now declare `prepare`, which runs to completion before the producer starts. Pass `--skip-build` to skip it when the client is already built and installed.

### `run:local:<name>` for any external consumer

Each external client used to need its own hardcoded `run:local:*` alias. `run:local:<name>` now runs the `consumers.external` entry with that name:

```bash
npx qvac-test run:local:kotlin-android   # same as run:local:external --name=kotlin-android
```

An unknown name fails before anything starts. `run:local:python` behaves as before.

Existing configurations are unaffected: a config that does not use `mode: 'mqtt'` or `prepare` runs exactly as on 0.12.2.
