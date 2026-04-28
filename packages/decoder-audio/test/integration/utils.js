'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

/**
 * Get path to a test asset file - works on both desktop and mobile
 * On mobile, asset files must be in test/mobile/testAssets/
 * On desktop, asset files are in example/ or test/mobile/testAssets/
 *
 * @param {string} filename - Name of the asset file (e.g., 'sample.mp3')
 * @param {object} options - Options
 * @param {string} options.desktopDir - Directory to look in on desktop (default: 'example')
 * @returns {string} - Full path to the asset file
 *
 * @example
 * const audioPath = getAssetPath('sample.mp3')
 * const audioStream = fs.createReadStream(audioPath)
 */
function getAssetPath (filename, options = {}) {
  const { desktopDir = 'example' } = options

  // Mobile environment - use asset loading from testAssets
  if (isMobile && global.assetPaths) {
    const projectPath = `../../testAssets/${filename}`

    if (global.assetPaths[projectPath]) {
      const resolvedPath = global.assetPaths[projectPath].replace('file://', '')
      return resolvedPath
    }
    // Asset not found in manifest
    throw new Error(`Asset not found in testAssets: ${filename}. Make sure ${filename} is in test/mobile/testAssets/ directory and rebuild the app.`)
  }

  // Desktop environment - check multiple locations
  const possiblePaths = [
    // First check testAssets (for test-specific files)
    path.resolve(__dirname, '../mobile/testAssets', filename),
    // Then check example directory
    path.resolve(__dirname, `../../${desktopDir}`, filename)
  ]

  for (const testPath of possiblePaths) {
    if (fs.existsSync(testPath)) {
      return testPath
    }
  }

  // Return the first path (will fail with appropriate error message)
  return possiblePaths[0]
}

/**
 * Check if running on mobile platform
 * @returns {boolean}
 */
function checkIsMobile () {
  return isMobile
}

module.exports = {
  getAssetPath,
  isMobile,
  checkIsMobile
}
