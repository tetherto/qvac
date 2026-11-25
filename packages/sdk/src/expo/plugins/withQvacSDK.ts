import configPlugins from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'
import { getProjectRootFromBaseConfig } from './get-project-root'
import withAndroidArchitecture from './withAndroidArchitecture'
import withAndroidNdkVersion from './withAndroidNdkVersion'
import withBareKit from './withBareKit'
import withDeviceInfo from './withDeviceInfo'
import withExpoBareKit, { findExpoBareKit } from './withExpoBareKit'
import withMobileBundle, { type MobileBundleOptions } from './withMobileBundle'
import withOpenCL from './withOpenCL'

const { withPlugins } = configPlugins

type QvacSDKPluginOptions = MobileBundleOptions

/**
 * Main Qvac SDK Expo plugin that combines all necessary mobile configurations:
 * - Mobile worker bundle generation
 * - Bare Kit and the native addons as a Gradle module and a Swift package, or
 *   the worker added to expo-bare-kit when the app installs it
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
  const projectRoot = getProjectRootFromBaseConfig(config) ?? process.cwd()
  const expoBareKitDir = findExpoBareKit(projectRoot)
  const bareKit: Parameters<typeof withPlugins>[1] =
    expoBareKitDir === null
      ? [[withMobileBundle, options], withBareKit]
      : [[withExpoBareKit, { ...options, projectRoot, expoBareKitDir }]]

  return withPlugins(config, [
    ...bareKit,
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
