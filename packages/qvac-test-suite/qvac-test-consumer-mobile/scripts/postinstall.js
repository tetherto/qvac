#!/usr/bin/env node

/**
 * Postinstall script that handles Windows-specific workarounds
 * Fixes bare-link's non-working patchelf executable on Windows
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const url = require('url');
const crypto = require('crypto');
const { execSync } = require('child_process');

const isWindows = os.platform() === 'win32';

/**
 * Downloads a file from a URL and verifies its SHA256 checksum
 * Handles redirects (301, 302, 307, 308) up to maxRedirects times
 */
function downloadFile(downloadUrl, targetPath, expectedSha256, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }

    const parsedUrl = url.parse(downloadUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Node.js'
      }
    };

    client.get(requestOptions, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = url.resolve(downloadUrl, response.headers.location);
        // Consume the response to free up the connection
        response.resume();
        // Follow redirect recursively
        return downloadFile(redirectUrl, targetPath, expectedSha256, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'] || '0', 10);
      const chunks = [];
      let downloadedSize = 0;
      let lastProgress = 0;
      let lastDotSize = 0;

      response.on('data', (chunk) => {
        chunks.push(chunk);
        downloadedSize += chunk.length;

        // Report progress every 10% or if we don't know the size, show dots every 100KB
        if (totalSize > 0) {
          const progress = Math.floor((downloadedSize / totalSize) * 100);
          if (progress >= lastProgress + 10) {
            process.stdout.write('.');
            lastProgress = progress;
          }
        } else if (downloadedSize - lastDotSize >= 102400) {
          process.stdout.write('.');
          lastDotSize = downloadedSize;
        }
      });

      response.on('end', () => {
        if (downloadedSize > 0) {
          process.stdout.write('\n');
        }

        const buffer = Buffer.concat(chunks);

        // Verify SHA256
        console.log('   🔐 Verifying checksum...');
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        if (hash !== expectedSha256) {
          reject(new Error(`SHA256 mismatch: expected ${expectedSha256}, got ${hash}`));
          return;
        }

        // Write file
        fs.writeFileSync(targetPath, buffer);
        resolve();
      });
    }).on('error', reject);
  });
}

/**
 * Fixes bare-link's non-working patchelf executable on Windows
 */
async function fixBareLinkPatchelf() {
  console.log('🔧 Checking bare-link patchelf...');

  const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
  const bareLinkPath = path.join(nodeModulesPath, 'bare-link');
  const bareLinkPackageJson = path.join(bareLinkPath, 'package.json');

  // Check if bare-link is installed
  if (!fs.existsSync(bareLinkPackageJson)) {
    console.log('   ⊘ bare-link not found, skipping');
    return;
  }

  // Check bare-link version and get patchelf path
  let patchelfPath;
  try {
    const packageJson = JSON.parse(fs.readFileSync(bareLinkPackageJson, 'utf8'));
    const version = packageJson.version;
    const majorVersion = parseInt(version.split('.')[0], 10);

    if (majorVersion >= 2) {
      console.log(`   ⊘ bare-link ${version} >= 2.0.0, skipping`);
      return;
    }

    console.log(`   ✓ Found bare-link ${version}`);

    // Try to get patchelf path from package.json imports
    if (packageJson.imports && packageJson.imports['#patchelf']) {
      const patchelfImport = packageJson.imports['#patchelf'];
      let relativePath;

      // Handle different package.json structures
      if (typeof patchelfImport === 'string') {
        relativePath = patchelfImport;
      } else if (patchelfImport.win32) {
        // Could be direct string or object with arch
        relativePath = typeof patchelfImport.win32 === 'string'
          ? patchelfImport.win32
          : patchelfImport.win32.x64;
      }

      if (relativePath) {
        // Remove leading './' if present
        relativePath = relativePath.replace(/^\.\//, '');
        patchelfPath = path.join(bareLinkPath, relativePath);
        console.log(`   ✓ Using patchelf path from package.json: ${relativePath}`);
      }
    }

    // Fallback to hardcoded path if not found in package.json
    if (!patchelfPath) {
      patchelfPath = path.join(bareLinkPath, 'prebuilds', 'win32-x64', 'patchelf.exe');
      console.log('   ℹ Using default patchelf path');
    }
  } catch (e) {
    return; // Silently skip on error
  }

  // Check if patchelf executable exists
  if (!fs.existsSync(patchelfPath)) {
    console.log('   ⊘ patchelf.exe not found, skipping');
    return;
  }

  console.log('   ✓ Found patchelf.exe');

  // Test if patchelf works
  let patchelfWorks = false;
  try {
    const output = execSync(`"${patchelfPath}" --version`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe'
    });
    if (output && output.trim().length > 0) {
      patchelfWorks = true;
      console.log('   ✓ patchelf is working');
    }
  } catch (e) {
    // patchelf doesn't work
  }

  if (patchelfWorks) {
    return; // Nothing to fix
  }

  console.log('   ⚠ patchelf not responding, downloading fix...');

  // Download and replace patchelf
  const downloadUrl = 'https://github.com/NixOS/patchelf/releases/download/0.18.0/patchelf-win64-0.18.0.exe';
  const expectedSha256 = 'ea5293833b6a547612ce4b073ac84fd603011ce3455f488a1017fabc8bd170ff';

  try {
    process.stdout.write('   ⬇ Downloading');
    await downloadFile(downloadUrl, patchelfPath, expectedSha256);
    console.log('   ✅ patchelf fixed successfully');
  } catch (e) {
    console.log(`\n   ⊘ Failed to fix patchelf: ${e.message}`);
  }
}

async function main() {
  if (isWindows) {
    console.log('🪟 Windows detected - applying Windows-specific fixes');

    // Fix bare-link patchelf if needed
    await fixBareLinkPatchelf();

    console.log('✅ Windows postinstall complete');
  } else {
    console.log('✅ Postinstall complete (non-Windows platform)');
  }

  // Apply lazy-loading transformations
  console.log('🔄 Applying lazy-loading...');
  try {
    execSync('node scripts/apply-lazy-loading.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  } catch (err) {
    console.error('⚠️  Failed to apply lazy-loading:', err.message);
    // Don't fail the install if lazy-loading fails
  }
}

main().catch((err) => {
  console.error('❌ Postinstall error:', err);
  process.exit(1);
});


