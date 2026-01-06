const { withAndroidManifest, withPlugins, withAppBuildGradle } = require('@expo/config-plugins');

/**
 * Plugin to add OpenCL native library support to Android build
 */
const withOpenCLConfig = (config) => {
  return withPlugins(config, [
    withOpenCLAndroidManifest,
    withOpenCLBuildGradle,
  ]);
};

/**
 * Modify AndroidManifest.xml to include OpenCL native library
 */
const withOpenCLAndroidManifest = (config) => {
  return withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;
    
    // Find the application element
    const application = androidManifest.manifest.application?.[0];
    
    if (application) {
      // Check if uses-native-library already exists
      const existingNativeLib = application['uses-native-library']?.find(
        lib => lib.$?.['android:name'] === 'libOpenCL.so'
      );
      
      if (!existingNativeLib) {
        // Add uses-native-library if it doesn't exist
        if (!application['uses-native-library']) {
          application['uses-native-library'] = [];
        }
        
        application['uses-native-library'].push({
          $: {
            'android:name': 'libOpenCL.so',
            'android:required': 'false'
          }
        });
      }
    }
    
    return config;
  });
};

/**
 * Modify build.gradle to exclude OpenCL library from packaging
 */
const withOpenCLBuildGradle = (config) => {
  return withAppBuildGradle(config, (config) => {
    const buildGradleContent = config.modResults.contents;
    
    // Check if the exclusion already exists
    if (buildGradleContent.includes('excludes += "/lib/**/libOpenCL.so"')) {
      return config;
    }
    
    // Try to find existing jniLibs block within packagingOptions and add the exclusion
    const jniLibsBlockRegex = /(packagingOptions\s*{[\s\S]*?jniLibs\s*{[^}]*)(})/;
    
    if (jniLibsBlockRegex.test(buildGradleContent)) {
      // Add excludes to existing jniLibs block
      config.modResults.contents = buildGradleContent.replace(
        jniLibsBlockRegex,
        (match, before, after) => {
          return before + '\n            excludes += "/lib/**/libOpenCL.so"' + '\n        ' + after;
        }
      );
    } else {
      // Check if packagingOptions exists but without jniLibs block
      const packagingOptionsRegex = /(packagingOptions\s*{)([^}]*})/;
      
      if (packagingOptionsRegex.test(buildGradleContent)) {
        // Add jniLibs block to existing packagingOptions
        config.modResults.contents = buildGradleContent.replace(
          packagingOptionsRegex,
          (match, before, content) => {
            const jniLibsConfig = `\n        jniLibs {\n            useLegacyPackaging (findProperty('expo.useLegacyPackaging')?.toBoolean() ?: false)\n            excludes += "/lib/**/libOpenCL.so"\n        }\n    `;
            return before + jniLibsConfig + content;
          }
        );
      } else {
        // No packagingOptions exists, add the entire block before the dependencies block
        const beforeDependenciesRegex = /(android\s*{[\s\S]*?)(^\s*}\s*$[\s\S]*?dependencies\s*{)/m;
        
        if (beforeDependenciesRegex.test(buildGradleContent)) {
          config.modResults.contents = buildGradleContent.replace(
            beforeDependenciesRegex,
            (match, androidBlock, betweenBlocks) => {
              const packagingConfig = `    packagingOptions {\n        jniLibs {\n            useLegacyPackaging (findProperty('expo.useLegacyPackaging')?.toBoolean() ?: false)\n            excludes += "/lib/**/libOpenCL.so"\n        }\n    }\n`;
              return androidBlock + packagingConfig + betweenBlocks;
            }
          );
        }
      }
    }
    
    return config;
  });
};

module.exports = withOpenCLConfig; 