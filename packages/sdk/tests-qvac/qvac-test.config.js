// SDK tests configuration
/** @type {import('@tetherto/qvac-test-suite').QvacTestConfig} */
export default {
  // All MQTT configuration under one object
  mqtt: {
    // Broker configuration (separate host/port)
    broker: {
      protocol: { env: "MQTT_PROTOCOL" },
      host: { env: "MQTT_HOST" },
      port: { env: "MQTT_PORT" },
      path: { env: "MQTT_PATH" },
    },

    // Authentication
    username: { env: "MQTT_USERNAME" },
    password: { env: "MQTT_PASSWORD" },

    // Disable certificate validation for self-signed certs (testing only)
    rejectUnauthorized: true,

    // Optional: TLS certificates
    // caPath: { env: "MQTT_CA_PATH" },
    // certPath: { env: 'MQTT_CERT_PATH' },
    // keyPath: { env: 'MQTT_KEY_PATH' },
  },

  testDir: "./dist/tests",

  consumers: {
    shared: {
      include: ["./dist/tests/shared/**"],
    },
    desktop: {
      platforms: ["macos"],
      entry: "./dist/tests/desktop/consumer.js",
      include: ["./tests/**"],
      dependencies: "auto",
    },
    mobile: {
      platforms: ["ios", "android"],
      entry: "./dist/tests/mobile/consumer.js",
      include: ["./dist/tests/**"],
      dependencies: "auto",
      mobileInit: "./mobile-cache-init.ts",
      metroConfig: "./metro.config.js",
      expoPlugins: [
        "@qvac/sdk/expo-plugin",
      ],
      assets: {
        patterns: [
          "./assets/audio/**/*",
          "./assets/images/**/*",
          "./assets/documents/**/*",
        ],
      },
    },
  },
};
