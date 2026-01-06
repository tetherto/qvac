const { withAppBuildGradle } = require("@expo/config-plugins");

module.exports = function withNdkVersion(config, props = {}) {
  const { ndkVersion } = props;

  if (!ndkVersion) {
    return config;
  }

  return withAppBuildGradle(config, (config) => {
    // Replace the dynamic reference with a hardcoded version
    config.modResults.contents = config.modResults.contents.replace(
      /ndkVersion\s+rootProject\.ext\.ndkVersion/,
      `ndkVersion "${ndkVersion}"`
    );

    return config;
  });
};
