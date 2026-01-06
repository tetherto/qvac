'use strict'

const fs = require('fs')

/**
 * @param {string} filePath - Path to the JavaScript file to parse
 * @param {string[]} [ignorePackages=[]] - Array of package names to ignore/filter out
 * @returns {string[]} Array of unique package names found in the file
 */
function parseFileDependencies (filePath, ignorePackages = []) {
  const content = fs.readFileSync(filePath, 'utf8')
  const packages = new Set()

  // Match CommonJS requires
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g
  let match
  while ((match = requireRegex.exec(content)) !== null) {
    const pkg = match[1]
    if (!ignorePackages.includes(pkg)) {
      packages.add(pkg)
    }
  }

  // Match ESM imports
  const importRegex = /import\s+(?:{[^}]*}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g
  while ((match = importRegex.exec(content)) !== null) {
    const pkg = match[1]
    if (!ignorePackages.includes(pkg)) {
      packages.add(pkg)
    }
  }

  return Array.from(packages)
}

module.exports = { parseFileDependencies }
