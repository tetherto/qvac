#!/usr/bin/env node

/**
 * Windows-compatible install script that works around patchelf issues
 * This script sets environment variables to skip patchelf operations
 * and handles Windows-specific installation requirements
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const isWindows = os.platform() === 'win32';

if (!isWindows) {
  console.log('This script is for Windows only. Use regular npm install on other platforms.');
  process.exit(0);
}

console.log('🔧 Running Windows-compatible install...');
console.log('⚠️  Skipping patchelf operations (not available on Windows)');

// Prepare environment with variables to skip patchelf operations
const env = {
  ...process.env,
  SKIP_PATCHELF: '1',
  PATCHELF_SKIP: '1',
  BARE_RUNTIME_SKIP_PATCHELF: '1',
  npm_config_optional: 'false',
};

// Set in current process too
process.env.SKIP_PATCHELF = '1';
process.env.PATCHELF_SKIP = '1';
process.env.BARE_RUNTIME_SKIP_PATCHELF = '1';
process.env.npm_config_optional = 'false';

try {
  // Determine which command to run
  const useCI = process.argv.includes('--ci');
  const args = useCI
    ? ['ci', '--ignore-scripts=false']
    : ['install', '--legacy-peer-deps', '--ignore-scripts=false'];
  
  console.log(`Running: npm ${args.join(' ')}`);
  console.log('Environment variables set: SKIP_PATCHELF, PATCHELF_SKIP, BARE_RUNTIME_SKIP_PATCHELF');
  
  // Use spawn to ensure environment variables are passed correctly
  const npmProcess = spawn('npm', args, {
    stdio: 'inherit',
    env: env,
    shell: true,
    cwd: path.join(__dirname, '..'),
  });
  
  npmProcess.on('close', (code) => {
    if (code === 0) {
      console.log('✅ Installation completed successfully!');
      console.log('💡 You can now run: npm run android');
    } else {
      console.error(`❌ Installation failed with exit code ${code}`);
      process.exit(code);
    }
  });
  
  npmProcess.on('error', (error) => {
    console.error('❌ Failed to start npm:', error.message);
    process.exit(1);
  });
} catch (error) {
  console.error('❌ Installation failed:', error.message);
  process.exit(1);
}

