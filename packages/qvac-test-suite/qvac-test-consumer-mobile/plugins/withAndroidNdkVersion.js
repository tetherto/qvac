const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Custom Expo config plugin to set NDK version in android/build.gradle
 * This ensures NDK 29 is used to match the addon build version
 */
const withAndroidNdkVersion = (config, ndkVersion = "29.0.14206865") => {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const buildGradlePath = path.join(config.modRequest.platformProjectRoot, "build.gradle");
      
      if (fs.existsSync(buildGradlePath)) {
        let buildGradle = fs.readFileSync(buildGradlePath, "utf8");

        // Check if ndkVersion already exists
        if (buildGradle.includes("ndkVersion")) {
          // Replace existing ndkVersion
          buildGradle = buildGradle.replace(
            /ndkVersion\s*=\s*["'][^"']+["']/g,
            `ndkVersion = "${ndkVersion}"`
          );
        } else {
          // Add ext block with ndkVersion after buildscript {
          buildGradle = buildGradle.replace(
            /(buildscript\s*\{)/,
            `$1\n  ext {\n    ndkVersion = "${ndkVersion}"\n  }`
          );
        }

        fs.writeFileSync(buildGradlePath, buildGradle);
      }

      return config;
    },
  ]);
};

module.exports = withAndroidNdkVersion;

