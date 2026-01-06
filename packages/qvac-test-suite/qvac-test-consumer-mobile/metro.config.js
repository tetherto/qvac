const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push(
  'txt',
  'py',
  'html',
  'json',  // Treat as asset data
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'wma'
);

// Watch parent directory to access shared-test-data
config.watchFolders = [
  path.resolve(__dirname, '..'), // (qvac-sdk-tests)
];

// Ensure @babel/runtime and other dependencies can be resolved from shared directories
// Metro needs to know where to find node_modules when resolving from watchFolders
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(__dirname, '..', 'node_modules'),
];

module.exports = config;
