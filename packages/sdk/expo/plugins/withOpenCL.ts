import configPlugins from "@expo/config-plugins";
import type { ExpoConfig } from "expo/config";

const { withAndroidManifest, withAppBuildGradle } = configPlugins;

/**
 * Plugin to add OpenCL native library support to Android build
 * This plugin was written by the most helpful folk in the QVAC team: Luis Moromisato.
 * Thank you Luis!
 */
function withOpenCL(config: ExpoConfig): ExpoConfig {
  config = withOpenCLAndroidManifest(config);
  config = withOpenCLBuildGradle(config);
  return config;
}

/**
 * Modify AndroidManifest.xml to include OpenCL native library
 */
function withOpenCLAndroidManifest(config: ExpoConfig) {
  return withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;

    // Find the application element
    const application = androidManifest.manifest.application?.[0];

    if (application) {
      // Type assertion for dynamic manifest properties
      const appWithNativeLibs = application as typeof application & {
        "uses-native-library"?: Array<{ $: { "android:name": string } }>;
      };

      // Check if uses-native-library already exists
      const existingNativeLib = appWithNativeLibs["uses-native-library"]?.find(
        (lib) => lib.$["android:name"] === "libOpenCL.so",
      );

      if (!existingNativeLib) {
        // Add uses-native-library if it doesn't exist
        if (!appWithNativeLibs["uses-native-library"]) {
          appWithNativeLibs["uses-native-library"] = [];
        }

        appWithNativeLibs["uses-native-library"].push({
          $: {
            "android:name": "libOpenCL.so",
          },
        });
      }
    }

    return config;
  });
}

/**
 * Modify build.gradle to exclude OpenCL library from packaging
 * FIXED VERSION: Properly handles existing packagingOptions blocks
 */
function withOpenCLBuildGradle(config: ExpoConfig) {
  return withAppBuildGradle(config, (config) => {
    let buildGradleContent = config.modResults.contents;

    // Check if the exclusion already exists anywhere in the file
    if (buildGradleContent.includes('excludes += "/lib/**/libOpenCL.so"')) {
      console.log(
        "[withOpenCL] OpenCL exclusion already exists in build.gradle",
      );
      return config;
    }

    // Find ALL packagingOptions blocks in the android block
    const androidBlockMatch = buildGradleContent.match(
      /android\s*{([\s\S]*?)^}/m,
    );
    if (!androidBlockMatch) {
      console.error(
        "[withOpenCL] Could not find android block in build.gradle",
      );
      return config;
    }

    const androidBlockContent = androidBlockMatch[1];

    // Check if there's already a packagingOptions block with jniLibs
    const existingJniLibsMatch = androidBlockContent?.match(
      /packagingOptions\s*{[\s\S]*?jniLibs\s*{[\s\S]*?}/g,
    );

    if (existingJniLibsMatch && existingJniLibsMatch.length > 0) {
      // Find the FIRST packagingOptions block with jniLibs and modify it
      // This ensures we don't create duplicate blocks
      const firstJniLibsBlockRegex =
        /(packagingOptions\s*{[\s\S]*?jniLibs\s*{[\s\S]*?)(})/;

      buildGradleContent = buildGradleContent.replace(
        firstJniLibsBlockRegex,
        (match, before, closing) => {
          // Check if this specific block already has the exclusion
          if (match.includes('excludes += "/lib/**/libOpenCL.so"')) {
            return match;
          }

          // Add the exclusion before the closing brace of jniLibs
          return (
            before +
            '            excludes += "/lib/**/libOpenCL.so"\n        ' +
            closing
          );
        },
      );

      console.log(
        "[withOpenCL] Added OpenCL exclusion to existing packagingOptions block",
      );
    } else {
      // No existing packagingOptions with jniLibs found
      // Check if there's ANY packagingOptions block
      const anyPackagingOptionsMatch = androidBlockContent?.match(
        /packagingOptions\s*{[\s\S]*?}/,
      );

      if (anyPackagingOptionsMatch) {
        // Add jniLibs section to existing packagingOptions
        const packagingOptionsRegex =
          /(packagingOptions\s*{)([\s\S]*?)(^\s*})/m;
        buildGradleContent = buildGradleContent.replace(
          packagingOptionsRegex,
          (_, opening, content, closing) => {
            const jniLibsSection = `
        jniLibs {
            def enableLegacyPackaging = findProperty('expo.useLegacyPackaging') ?: 'false'
            useLegacyPackaging enableLegacyPackaging.toBoolean()
            excludes += "/lib/**/libOpenCL.so"
        }`;
            return opening + content + jniLibsSection + "\n" + closing;
          },
        );
        console.log(
          "[withOpenCL] Added jniLibs section to existing packagingOptions block",
        );
      } else {
        // No packagingOptions at all, add a new one before the closing of android block
        const androidBlockRegex = /(android\s*{[\s\S]*?)(^})/m;
        buildGradleContent = buildGradleContent.replace(
          androidBlockRegex,
          (_, before, closing) => {
            const packagingConfig = `
    packagingOptions {
        jniLibs {
            def enableLegacyPackaging = findProperty('expo.useLegacyPackaging') ?: 'false'
            useLegacyPackaging enableLegacyPackaging.toBoolean()
            excludes += "/lib/**/libOpenCL.so"
        }
    }
`;
            return before + packagingConfig + closing;
          },
        );
        console.log(
          "[withOpenCL] Added new packagingOptions block with OpenCL exclusion",
        );
      }
    }

    config.modResults.contents = buildGradleContent;
    return config;
  });
}

export default withOpenCL;
