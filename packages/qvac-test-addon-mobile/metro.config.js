const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push("so", "bin", "model", "bundle", "raw", "onnx");

module.exports = config;