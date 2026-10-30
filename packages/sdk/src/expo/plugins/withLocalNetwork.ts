import configPlugins from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'

const { withInfoPlist, withAndroidManifest, AndroidConfig } = configPlugins

export default function withLocalNetwork(config: ExpoConfig): ExpoConfig {
  config = withInfoPlist(config, (mod) => {
    mod.modResults['NSLocalNetworkUsageDescription'] ??=
      'Discover and connect to QVAC inference servers on your local network.'
    return mod
  })
  return withAndroidManifest(config, (mod) => {
    AndroidConfig.Permissions.ensurePermissions(mod.modResults, [
      'android.permission.INTERNET',
      'android.permission.ACCESS_WIFI_STATE',
      'android.permission.CHANGE_WIFI_MULTICAST_STATE'
    ])
    return mod
  })
}
