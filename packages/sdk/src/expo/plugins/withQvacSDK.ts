import configPlugins from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'
import withAndroidArchitecture from './withAndroidArchitecture'
import withAndroidNdkVersion from './withAndroidNdkVersion'
import withDeviceInfo from './withDeviceInfo'
import withMobileBundle, { type MobileBundleOptions } from './withMobileBundle'
import withOpenCL from './withOpenCL'

const { withPlugins } = configPlugins

type QvacSDKPluginOptions = MobileBundleOptions

/**
 * Main Qvac SDK Expo plugin that combines all necessary mobile configurations:
 * - Mobile worker bundle generation
 * - Device info stubbing when expo-device is not installed
 * - Android build properties (minSdkVersion, NDK, proguard)
 * - Android NDK version pinning in build.gradle
 * - Android architecture filtering (arm64-v8a only)
 * - OpenCL native library support for Android
 *
 * Options (`["@qvac/sdk/expo-plugin", { ... }]` in app.json) go to
 * `withMobileBundle`.
 */
function withQvacSDK(config: ExpoConfig, options: QvacSDKPluginOptions = {}): ExpoConfig {
  return withPlugins(config, [
    [withMobileBundle, options],
    withDeviceInfo,
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 29,
          ndkVersion: '29.0.14206865',
          enableProguardInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
          enableMinifyInReleaseBuilds: true
        }
      }
    ],
    withAndroidNdkVersion,
    withAndroidArchitecture,
    withOpenCL
  ])
}

export type { QvacSDKPluginOptions }

export default withQvacSDK
