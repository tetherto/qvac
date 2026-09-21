const { withAndroidManifest } = require('@expo/config-plugins')

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults
    const mainApplication = androidManifest.manifest.application[0]

    // Add usesCleartextTraffic to application tag. This is required for the MQTT connection to work locally (simple WS connection, not WSS)
    mainApplication.$['android:usesCleartextTraffic'] = 'true'

    return config
  })
}
