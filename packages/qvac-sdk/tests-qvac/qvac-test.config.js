// SDK tests configuration
export default {
  // All MQTT configuration under one object
  mqtt: {
    // Broker configuration (separate host/port)
    broker: {
      protocol: { env: "MQTT_PROTOCOL" },
      host: { env: "MQTT_HOST" },
      port: { env: "MQTT_PORT" },
    },

    // Authentication
    username: { env: "MQTT_USERNAME" },
    password: { env: "MQTT_PASSWORD" },

    // Disable certificate validation for self-signed certs (testing only)
    rejectUnauthorized: false,

    // Optional: TLS certificates
    caPath: { env: "MQTT_CA_PATH" },
    // certPath: { env: 'MQTT_CERT_PATH' },
    // keyPath: { env: 'MQTT_KEY_PATH' },
  },

  testDir: "./dist/tests",

  consumers: {
    desktop: {
      platforms: ["macos"],
      entry: "./dist/tests/desktop/consumer.js",
      include: ["./tests/**"],
      dependencies: "auto",
    },
  },
};
