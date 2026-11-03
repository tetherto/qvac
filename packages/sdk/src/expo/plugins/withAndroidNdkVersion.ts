import configPlugins from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'
import * as fs from 'fs'
import * as path from 'path'

const { withDangerousMod } = configPlugins

const DEFAULT_NDK_VERSION = '29.0.14206865'

/**
 * Expo plugin to set NDK version in android/build.gradle.
 * Ensures NDK 29 is used to match the addon build version.
 */
function withAndroidNdkVersion(config: ExpoConfig): ExpoConfig {
  const ndkVersion = DEFAULT_NDK_VERSION
  return withDangerousMod(config, [
    'android',
    function (config) {
      const buildGradlePath = path.join(config.modRequest.platformProjectRoot, 'build.gradle')

      let buildGradle: string
      try {
        buildGradle = fs.readFileSync(buildGradlePath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return config
        throw err
      }

      if (buildGradle.includes('ndkVersion')) {
        buildGradle = buildGradle.replace(
          /ndkVersion\s*=\s*["'][^"']+["']/g,
          `ndkVersion = "${ndkVersion}"`
        )
      } else {
        buildGradle = buildGradle.replace(
          /(buildscript\s*\{)/,
          `$1\n  ext {\n    ndkVersion = "${ndkVersion}"\n  }`
        )
      }

      fs.writeFileSync(buildGradlePath, buildGradle)
      console.log(`[withAndroidNdkVersion] 🔧 QVAC: Set Android NDK version to ${ndkVersion}`)

      return config
    }
  ])
}

export default withAndroidNdkVersion
