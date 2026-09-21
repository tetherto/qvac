const { withDangerousMod, withAndroidManifest } = require('@expo/config-plugins')
const fs = require('fs')
const path = require('path')

/**
 * Add network security config with custom CA certificate
 * This allows Android to trust certificates signed by your custom CA
 */
module.exports = function withNetworkSecurityConfig(config, caCertContent) {
  // Update AndroidManifest.xml to reference the network security config
  config = withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults
    const application = androidManifest.manifest.application[0]

    // Add networkSecurityConfig attribute
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config'

    return config
  })

  // Create the network_security_config.xml file
  return withDangerousMod(config, [
    'android',
    // lunte-disable-next-line require-await
    async (config) => {
      const platformProjectRoot = config.modRequest.platformProjectRoot

      // Create res/xml directory if it doesn't exist
      const resXmlPath = path.join(platformProjectRoot, 'app', 'src', 'main', 'res', 'xml')
      if (!fs.existsSync(resXmlPath)) {
        fs.mkdirSync(resXmlPath, { recursive: true })
      }

      let networkSecurityConfig

      if (caCertContent) {
        // Create res/raw directory for the CA certificate
        const resRawPath = path.join(platformProjectRoot, 'app', 'src', 'main', 'res', 'raw')
        if (!fs.existsSync(resRawPath)) {
          fs.mkdirSync(resRawPath, { recursive: true })
        }

        // Write CA certificate to res/raw/ca_cert.crt
        const caCertPath = path.join(resRawPath, 'ca_cert.crt')
        fs.writeFileSync(caCertPath, caCertContent)

        // Create network_security_config.xml that references the custom CA
        networkSecurityConfig = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Trust custom CA certificate for all domains -->
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <!-- Trust system CAs -->
            <certificates src="system" />
            <!-- Trust custom CA certificate -->
            <certificates src="@raw/ca_cert" />
        </trust-anchors>
    </base-config>
    
    <!-- Debug overrides -->
    <debug-overrides>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="@raw/ca_cert" />
        </trust-anchors>
    </debug-overrides>
</network-security-config>
`
      } else {
        // No custom CA - just allow cleartext and user certs
        networkSecurityConfig = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
    
    <debug-overrides>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </debug-overrides>
</network-security-config>
`
      }

      const networkSecurityConfigPath = path.join(resXmlPath, 'network_security_config.xml')
      fs.writeFileSync(networkSecurityConfigPath, networkSecurityConfig)

      return config
    }
  ])
}
