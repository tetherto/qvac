#!/usr/bin/env node
/**
 * Orchestrates docs generation: reads SDK version from packages/qvac-sdk/package.json,
 * runs docs:generate-api and docs:update-versions. Output goes to docs/website/.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const sdkPackagePath = path.join(repoRoot, 'packages/qvac-sdk/package.json');
const docsDir = path.join(repoRoot, 'docs');

if (!fs.existsSync(sdkPackagePath)) {
  console.error('packages/qvac-sdk/package.json not found');
  process.exit(1);
}

const sdkPackage = JSON.parse(fs.readFileSync(sdkPackagePath, 'utf8'));
const version = sdkPackage.version;
if (!version) {
  console.error('No version in packages/qvac-sdk/package.json');
  process.exit(1);
}

console.log('SDK version:', version);
execSync(`npm run docs:generate-api -- ${version}`, {
  stdio: 'inherit',
  cwd: docsDir,
});
execSync(`npm run docs:update-versions -- ${version}`, {
  stdio: 'inherit',
  cwd: docsDir,
});
console.log('docs:generate done');
