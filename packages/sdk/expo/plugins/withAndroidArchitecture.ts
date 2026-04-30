import configPlugins from "@expo/config-plugins";
import type { ExpoConfig } from "expo/config";

const { withGradleProperties, withAppBuildGradle } = configPlugins;

const DEFAULT_ARCHITECTURES = ["arm64-v8a"];

/**
 * Expo plugin to configure Android architecture to arm64-v8a only.
 * Reduces APK size by excluding other architectures (x86, x86_64, armeabi-v7a).
 */
function withAndroidArchitecture(config: ExpoConfig): ExpoConfig {
  const architectures = DEFAULT_ARCHITECTURES;
  const architectureString = architectures.join(",");
  const abiFiltersArray = architectures.map((arch) => `"${arch}"`).join(", ");

  // Update gradle.properties to set reactNativeArchitectures
  config = withGradleProperties(config, (config) => {
    const propIndex = config.modResults.findIndex(
      (item) =>
        item.type === "property" && item.key === "reactNativeArchitectures",
    );

    if (propIndex >= 0) {
      config.modResults.splice(propIndex, 1, {
        type: "property",
        key: "reactNativeArchitectures",
        value: architectureString,
      });
    } else {
      config.modResults.push({
        type: "property",
        key: "reactNativeArchitectures",
        value: architectureString,
      });
    }

    return config;
  });

  // Update app/build.gradle to add ndk.abiFilters
  config = withAppBuildGradle(config, (config) => {
    let buildGradle = config.modResults.contents;
    const ndkBlock = `\n        ndk {\n            abiFilters ${abiFiltersArray}\n        }`;

    if (!buildGradle.includes("ndk {")) {
      const buildConfigRegex =
        /(buildConfigField\s+"String",\s+"REACT_NATIVE_RELEASE_LEVEL"[^\n]*\n)/;

      if (buildConfigRegex.test(buildGradle)) {
        buildGradle = buildGradle.replace(buildConfigRegex, `$1${ndkBlock}\n`);
      }
    } else {
      const ndkRegex = /ndk\s*\{[^}]*\}/s;
      const newNdkBlock = `ndk {\n            abiFilters ${abiFiltersArray}\n        }`;
      buildGradle = buildGradle.replace(ndkRegex, newNdkBlock);
    }

    config.modResults.contents = buildGradle;
    return config;
  });

  console.log(
    `[withAndroidArchitecture] 🔧 QVAC: Set Android architectures to ${architectureString}`,
  );

  return config;
}

export default withAndroidArchitecture;
