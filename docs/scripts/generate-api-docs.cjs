#!/usr/bin/env node
/**
 * Generates SDK API docs into docs/website/content/docs/sdk/api/.
 * Runs TypeDoc via packages/qvac-sdk (docs:gen-api), then copies output to
 * docs/website/content/docs/sdk/api/vX.Y.Z and docs/website/content/docs/sdk/api/latest.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/generate-api-docs.cjs <version>');
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '../..');
const sdkDir = path.join(repoRoot, 'packages/qvac-sdk');
const typedocOut = path.join(sdkDir, '.docs-build/api');
const apiBase = path.join(repoRoot, 'docs/website/content/docs/sdk/api');
const versionDir = path.join(apiBase, `v${version}`);
const latestDir = path.join(apiBase, 'latest');

// Run TypeDoc in SDK package
execSync('npm run docs:gen-api', {
  stdio: 'inherit',
  cwd: sdkDir,
});

if (!fs.existsSync(typedocOut)) {
  console.error('TypeDoc output not found at', typedocOut);
  process.exit(1);
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const srcPath = path.join(src, name);
    const destPath = path.join(dest, name);
    if (fs.statSync(srcPath).isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Copy to versioned dir
fs.rmSync(versionDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(versionDir), { recursive: true });
copyRecursive(typedocOut, versionDir);
console.log('Wrote', versionDir);

// Copy to latest
fs.rmSync(latestDir, { recursive: true, force: true });
copyRecursive(typedocOut, latestDir);
console.log('Wrote', latestDir);

console.log('Generated API docs for v' + version);
