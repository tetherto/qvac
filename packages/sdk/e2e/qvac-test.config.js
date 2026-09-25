// SDK tests configuration
/** @type {import('@qvac/test-suite').QvacTestConfig} */
export default {
  // All MQTT configuration under one object
  mqtt: {
    // Broker configuration (separate host/port)
    broker: {
      protocol: { env: 'MQTT_PROTOCOL' },
      host: { env: 'MQTT_HOST' },
      port: { env: 'MQTT_PORT' },
      path: { env: 'MQTT_PATH' }
    },

    // Authentication
    username: { env: 'MQTT_USERNAME' },
    password: { env: 'MQTT_PASSWORD' },

    // Preserve QoS 1 state across reconnects while expiring abandoned CI sessions
    sessionExpiryInterval: process.env.GITHUB_ACTIONS === 'true' ? 2 * 60 * 60 : undefined,

    // Disable certificate validation for self-signed certs (testing only)
    rejectUnauthorized: true

    // Optional: TLS certificates
    // caPath: { env: "MQTT_CA_PATH" },
    // certPath: { env: 'MQTT_CERT_PATH' },
    // keyPath: { env: 'MQTT_KEY_PATH' },
  },

  testDir: './dist/tests',

  consumers: {
    shared: {
      include: ['./dist/tests/shared/**']
    },
    desktop: {
      platforms: ['macos'],
      entry: './dist/tests/desktop/consumer.js',
      include: ['./tests/**'],
      dependencies: 'auto'
    },
    electron: {
      platforms: ['macos', 'windows', 'linux'],
      entry: './dist/tests/electron/consumer.js',
      appDir: '.',
      appName: 'QVACSDKElectronE2E',
      include: ['./dist/tests/**', './fixtures/qvac.config.electron.json'],
      dependencies: 'auto',
      packageManager: 'npm',
      packageScript: 'package:electron'
    },
    snap: {
      runtime: 'electron',
      entry: './app/resources/app/dist/tests/electron/consumer.js',
      appDir: '.',
      snapName: 'qvac-sdk-e2e',
      appCommand: 'qvac-sdk-e2e',
      artifactPath: './snap/dist/qvac-sdk-e2e.snap',
      snapConfigDir: './app/resources/app',
      packageManager: 'npm',
      packageScript: 'package:snap'
    },
    // Non-JS clients that interpret the same catalog. The framework keeps the
    // MQTT state machine and drives the client over stdin/stdout, so the
    // protocol stays implemented once. Each entry is its own run and its own
    // CI leg — runs are single-consumer by design.
    external: [
      {
        name: 'python',
        platform: 'desktop-python',
        mode: 'bridge',
        // Windows puts a venv's interpreter under `Scripts`, every other
        // platform under `bin`. Hardcoding one of them is what would keep this
        // leg on a single OS.
        interpreter:
          process.platform === 'win32'
            ? '../../sdk-python/.venv/Scripts/python.exe'
            : '../../sdk-python/.venv/bin/python',
        args: ['-m', 'qvac_e2e.runner'],
        cwd: './python',
        env: {
          // Point the Python client at the worker this suite bundles, not a
          // stock one. Same binary as the JS legs, so any difference in a
          // result can only have come from the client. The Bare runtime is
          // resolved by the framework and injected as QVAC_BARE_PATH, so it
          // stays out of this file.
          QVAC_WORKER_PATH: '../qvac/worker.entry.mjs'
        }
      }
    ],
    mobile: {
      platforms: ['ios', 'android'],
      entry: './dist/tests/mobile/consumer.js',
      include: ['./dist/tests/**'],
      dependencies: 'auto',
      metroConfig: './metro.config.js',
      qvacConfig: './fixtures/qvac.config.e2e.json',
      expoPlugins: ['@qvac/sdk/expo-plugin'],
      assets: {
        patterns: [
          './assets/audio/**/*',
          './assets/images/**/*',
          './assets/documents/**/*',
          './fixtures/**/*'
        ]
      }
    }
  }
}
