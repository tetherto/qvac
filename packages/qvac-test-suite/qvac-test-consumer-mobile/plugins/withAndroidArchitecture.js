const {
  withGradleProperties,
  withAppBuildGradle,
} = require("@expo/config-plugins");

/**
 * Custom Expo config plugin to configure Android architecture to arm64-v8a only
 * This reduces APK size by excluding other architectures (x86, x86_64, armeabi-v7a)
 */
const withAndroidArchitecture = (config, architectures = ["arm64-v8a"]) => {
  // Update gradle.properties to set reactNativeArchitectures
  config = withGradleProperties(config, (config) => {
    const architectureString = architectures.join(",");

    // Find and update or add reactNativeArchitectures property
    const propIndex = config.modResults.findIndex(
      (item) =>
        item.type === "property" && item.key === "reactNativeArchitectures"
    );

    if (propIndex >= 0) {
      // Update existing property
      config.modResults[propIndex].value = architectureString;
    } else {
      // Add new property
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

    // Generate the ndk block with abiFilters
    const abiFiltersArray = architectures.map((arch) => `"${arch}"`).join(", ");
    const ndkBlock = `\n        ndk {\n            abiFilters ${abiFiltersArray}\n        }`;

    // Check if ndk block already exists
    if (!buildGradle.includes("ndk {")) {
      // Find the buildConfigField line and add ndk configuration after it
      const buildConfigRegex =
        /(buildConfigField\s+"String",\s+"REACT_NATIVE_RELEASE_LEVEL"[^\n]*\n)/;

      if (buildConfigRegex.test(buildGradle)) {
        buildGradle = buildGradle.replace(buildConfigRegex, `$1${ndkBlock}\n`);
      }
    } else {
      // Update existing ndk block
      const ndkRegex = /ndk\s*\{[^}]*\}/s;
      const newNdkBlock = `ndk {\n            abiFilters ${abiFiltersArray}\n        }`;

      buildGradle = buildGradle.replace(ndkRegex, newNdkBlock);
    }

    config.modResults.contents = buildGradle;
    return config;
  });

  return config;
};

module.exports = withAndroidArchitecture;
