#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

/**
 * Build Test App Script
 * 
 * Usage:
 *   node build-test-app.js <addon-path-or-tgz-or-package> [mobile-tests-dir]
 * 
 * If mobile-tests-dir is not provided, defaults to test/mobile within the installed addon package.
 * If that path doesn't exist, the script will exit with an error and instructions.
 * 
 * This script:
 * 1. Takes an addon path, .tgz file, or published npm package name
 * 2. Takes an optional tests directory (defaults to test/mobile within the installed addon package)
 * 3. Reads ALL .cjs files from the test/mobile/ directory
 * 4. Combines all test files (constants, helpers, test functions)
 * 5. Extracts individual test functions (async function declarations)
 * 6. Generates backend.cjs with individual test runners and error handling
 * 7. Generates testConfig.js with list of test functions
 * 8. Generates e2e/tests/app.test.js with WebDriver test cases
 * 9. Installs the addon package and dependencies
 * 10. Bundles the app
 * 
 * Supported addon input formats:
 * - Local directory: ./path/to/addon
 * - Local .tgz file: ./path/to/addon.tgz
 * - Published package: my-addon or @scope/my-addon
 * - Published package with version: my-addon@1.0.0 or @scope/my-addon@1.0.0
 * 
 * Examples:
 *   # Use default tests from installed package (if available)
 *   node build-test-app.js @qvac/llm-llamacpp
 * 
 *   # Use custom tests directory
 *   node build-test-app.js ../addon-source ../addon-source/test/mobile
 * 
 * Test file organization:
 * - All .cjs files in test/mobile/ are automatically ordered based on require() dependencies
 * - Files use require('./filename.cjs') to declare dependencies
 * - Build script creates a dependency graph and uses topological sort
 * - Users can name files anything and organize however they want
 * - No manual numbering required - dependencies are auto-detected
 * 
 * Example:
 *   constants.cjs         (no requires - loads first)
 *   helpers.cjs           (requires './constants.cjs' - loads second)
 *   accuracy-tests.cjs    (requires './helpers.cjs' - loads third)
 *   performance-tests.cjs (requires './helpers.cjs' - loads third)
 * 
 * How tests are run:
 * - Each test function is run individually via RUN_TEST RPC command
 * - Tests are isolated with try-catch, so one failure doesn't stop others
 * - Results are accumulated on screen as "testName: PASS" or "testName: FAIL"
 * - WebDriver tests check for these individual results
 */

function log(message) {
  console.log(`[BUILD] ${message}`)
}

function error(message) {
  console.error(`[ERROR] ${message}`)
  process.exit(1)
}

function copyDirectoryRecursive(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true })
      copyDirectoryRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * Get package name from addon source (before installation)
 * Works with directories, .tgz files, and npm package names
 */
function getPackageNameFromSource(addonSource, isLocalPath) {
  if (!isLocalPath) {
    // Extract package name from published package (handle @scope/name@version)
    const nameWithoutVersion = addonSource.split('@').filter(Boolean)
    if (addonSource.startsWith('@')) {
      return `@${nameWithoutVersion[0]}`
    } else {
      return nameWithoutVersion[0]
    }
  }
  
  const stats = fs.statSync(addonSource)
  const isDirectory = stats.isDirectory()
  
  if (isDirectory) {
    // Read package.json from directory
    const sourcePkgPath = path.join(addonSource, 'package.json')
    if (!fs.existsSync(sourcePkgPath)) {
      error(`No package.json found in directory: ${addonSource}`)
    }
    const sourcePkg = JSON.parse(fs.readFileSync(sourcePkgPath, 'utf8'))
    return sourcePkg.name
  } else {
    // Extract package name from .tgz
    const output = execSync(`tar -xzOf "${addonSource}" package/package.json`, {
      encoding: 'utf8'
    })
    const pkg = JSON.parse(output)
    return pkg.name
  }
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2)
  
  if (args.length < 1) {
    error('Usage: node build-test-app.js <addon-path-or-tgz-or-package> [mobile-tests-dir]\n' +
          '  If mobile-tests-dir is not provided, will use test/mobile within the installed addon package')
  }
  
  const addonSource = args[0]
  const projectRoot = path.resolve(__dirname, '..')
  
  // Check if it's a local path (directory or .tgz file)
  const isLocalPath = fs.existsSync(addonSource)
  
  // If not a local path, assume it's a published package name
  // Package names can be scoped (@scope/name) or unscoped (name)
  if (!isLocalPath) {
    log(`'${addonSource}' is not a local path, treating as published package name`)
  }
  
  // Get the package name from the addon source
  const packageName = getPackageNameFromSource(addonSource, isLocalPath)
  log(`Package name: ${packageName}`)
  
  // Determine tests directory
  let testsDir
  if (args.length >= 2) {
    testsDir = path.resolve(args[1])
  } else {
    // Default to test/mobile within the addon package
    testsDir = path.join(projectRoot, 'node_modules', packageName, 'test', 'mobile')
    log(`No tests directory provided, will use default: ${testsDir}`)
  }

  // For explicit test directories, validate immediately
  if (args.length >= 2) {
    if (!fs.existsSync(testsDir)) {
      error(`Provided mobile tests directory does not exist: ${testsDir}`)
    }
    if (!fs.statSync(testsDir).isDirectory()) {
      error(`Provided mobile tests path is not a directory: ${testsDir}`)
    }
    log(`Using mobile tests directory: ${testsDir}`)
  }
  // For default path, we'll validate after package installation
  
  return { addonSource, isLocalPath, testsDir, packageName, usingDefaultTestsDir: args.length < 2 }
}

/**
 * Check if addon is already installed with the same source
 */
function isAddonAlreadyInstalled(addonSource, isLocalPath, projectRoot) {
  const pkgJsonPath = path.join(projectRoot, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    return false
  }
  
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
  
  // Get the package name that will be installed
  let packageName
  if (!isLocalPath) {
    // Extract package name from published package (handle @scope/name@version)
    const nameWithoutVersion = addonSource.split('@').filter(Boolean)
    if (addonSource.startsWith('@')) {
      packageName = `@${nameWithoutVersion[0]}`
    } else {
      packageName = nameWithoutVersion[0]
    }
  } else {
    // For local paths, we need to read the package name from the source
    const stats = fs.statSync(addonSource)
    const isDirectory = stats.isDirectory()
    
    if (isDirectory) {
      const sourcePkgPath = path.join(addonSource, 'package.json')
      const sourcePkg = JSON.parse(fs.readFileSync(sourcePkgPath, 'utf8'))
      packageName = sourcePkg.name
    } else {
      // For .tgz, extract package name
      const output = execSync(`tar -xzOf "${addonSource}" package/package.json`, {
        encoding: 'utf8'
      })
      const pkg = JSON.parse(output)
      packageName = pkg.name
    }
  }
  
  // Check if package exists in dependencies
  const currentSource = pkgJson.dependencies?.[packageName]
  if (!currentSource) {
    return false
  }
  
  // For local paths, check if the source matches
  if (isLocalPath) {
    const resolvedSource = path.resolve(addonSource)
    const stats = fs.statSync(addonSource)
    const isDirectory = stats.isDirectory()
    
    // If current source is a .tgz file
    if (currentSource.endsWith('.tgz')) {
      if (isDirectory) {
        // Check if the .tgz was created from this directory
        // Extract the directory path from the .tgz path
        const tgzDir = path.dirname(currentSource)
        const resolvedTgzDir = path.resolve(projectRoot, tgzDir)
        
        // If the .tgz is in the same directory as our source, consider it installed
        return resolvedSource === resolvedTgzDir
      } else {
        // Both are .tgz files, compare paths
        const resolvedCurrent = path.resolve(projectRoot, currentSource)
        return resolvedSource === resolvedCurrent
      }
    }
    
    // For directories, they should match
    const resolvedCurrent = path.resolve(projectRoot, currentSource)
    return resolvedSource === resolvedCurrent
  }
  
  // For npm packages, if it exists, consider it installed
  // (user can manually update version if needed)
  return true
}

/**
 * Clean up duplicate dependencies in package.json and remove old package entry
 * This ensures a clean state before installing
 */
function cleanupAndRemovePackage(packageName, projectRoot) {
  const pkgJsonPath = path.join(projectRoot, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    return
  }
  
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
  
  // Remove the package if it exists
  if (pkgJson.dependencies && pkgJson.dependencies[packageName]) {
    log(`Removing existing ${packageName} entry before reinstalling...`)
    delete pkgJson.dependencies[packageName]
    
    // Write back the cleaned package.json
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf8')
  }
}

/**
 * Install addon package and get its installed path
 */
function installAddonPackage(addonSource, isLocalPath, projectRoot) {
  // Get the package name first
  let packageName
  if (!isLocalPath) {
    const nameWithoutVersion = addonSource.split('@').filter(Boolean)
    if (addonSource.startsWith('@')) {
      packageName = `@${nameWithoutVersion[0]}`
    } else {
      packageName = nameWithoutVersion[0]
    }
  } else {
    const stats = fs.statSync(addonSource)
    const isDirectory = stats.isDirectory()
    
    if (isDirectory) {
      const sourcePkgPath = path.join(addonSource, 'package.json')
      const sourcePkg = JSON.parse(fs.readFileSync(sourcePkgPath, 'utf8'))
      packageName = sourcePkg.name
    } else {
      const output = execSync(`tar -xzOf "${addonSource}" package/package.json`, {
        encoding: 'utf8'
      })
      const pkg = JSON.parse(output)
      packageName = pkg.name
    }
  }
  
  // Remove any existing entry to prevent duplicates
  cleanupAndRemovePackage(packageName, projectRoot)
  
  log('Installing addon package...')
  
  if (!isLocalPath) {
    // It's a published package name, install directly from npm
    log(`Installing package from npm: ${addonSource}`)
    execSync(`npm install --legacy-peer-deps "${addonSource}"`, {
      cwd: projectRoot,
      stdio: 'inherit'
    })
  } else {
    const stats = fs.statSync(addonSource)
    const isDirectory = stats.isDirectory()
    
    if (isDirectory) {
      // If it's a directory, pack it first
      log('Packing addon directory...')
      const packOutput = execSync('npm pack', {
        cwd: addonSource,
        encoding: 'utf8'
      }).trim()
      
      const tgzPath = path.join(addonSource, packOutput)
      log(`Created package: ${tgzPath}`)
      
      // Install the .tgz file
      execSync(`npm install --legacy-peer-deps "${tgzPath}"`, {
        cwd: projectRoot,
        stdio: 'inherit'
      })
      
      // Clean up the .tgz file
      fs.unlinkSync(tgzPath)
    } else {
      // It's a .tgz file, install directly
      execSync(`npm install --legacy-peer-deps "${addonSource}"`, {
        cwd: projectRoot,
        stdio: 'inherit'
      })
    }
  }
  
  log('Addon package installed successfully')
}

/**
 * Get package name from installed addon
 */
function getInstalledPackageName(addonSource, isLocalPath) {
  if (!isLocalPath) {
    if (addonSource.startsWith('@')) {
      const atIndex = addonSource.indexOf('@', 1)
      if (atIndex === -1) {
        return addonSource
      }
      return addonSource.substring(0, atIndex)
    } else {
      const atIndex = addonSource.indexOf('@')
      if (atIndex === -1) {
        return addonSource
      }
      return addonSource.substring(0, atIndex)
    }
  }
  
  const stats = fs.statSync(addonSource)
  const isDirectory = stats.isDirectory()
  
  if (isDirectory) {
    // Read package.json from source directory
    const pkgPath = path.join(addonSource, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    return pkg.name
  } else {
    // For .tgz, we need to extract package name from tarball
    // Use npm pack --json to get info without extracting
    const tgzDir = path.dirname(addonSource)
    const tgzFile = path.basename(addonSource)
    
    // Read the tarball's package.json
    const output = execSync(`tar -xzOf "${addonSource}" package/package.json`, {
      encoding: 'utf8'
    })
    const pkg = JSON.parse(output)
    return pkg.name
  }
}

/**
 * Extract local file dependencies from require() statements
 * Returns array of local .cjs filenames this file depends on
 */
function extractLocalDependencies(content, currentFile) {
  const dependencies = []
  
  // Match require('./filename.cjs') or require('./filename')
  const requireRegex = /require\s*\(\s*['"]\.\/([\w-]+)(\.cjs)?['"]\s*\)/g
  let match
  
  while ((match = requireRegex.exec(content)) !== null) {
    let depFile = match[1]
    // Add .cjs extension if not present
    if (!depFile.endsWith('.cjs')) {
      depFile += '.cjs'
    }
    dependencies.push(depFile)
  }
  
  return dependencies
}

/**
 * Topologically sort files based on their dependencies
 * Returns array of filenames in correct load order
 */
function topologicalSort(filesWithDeps) {
  const sorted = []
  const visited = new Set()
  const visiting = new Set()
  
  function visit(file) {
    if (visited.has(file)) return
    if (visiting.has(file)) {
      throw new Error(`Circular dependency detected involving: ${file}`)
    }
    
    visiting.add(file)
    
    const fileData = filesWithDeps.find(f => f.file === file)
    if (fileData) {
      // Visit dependencies first
      for (const dep of fileData.dependencies) {
        visit(dep)
      }
    }
    
    visiting.delete(file)
    visited.add(file)
    sorted.push(file)
  }
  
  // Visit all files
  for (const { file } of filesWithDeps) {
    visit(file)
  }
  
  return sorted
}

/**
 * Read all test code files from installed addon in node_modules
 * Reads all .cjs files from test/mobile/ directory and combines them
 * Smart ordering: constants → helpers → tests (auto-detected)
 */
function readTestCode(testsDir) {
  const baseDir = testsDir
  
  if (!fs.existsSync(baseDir)) {
    error(`Test directory not found: ${baseDir}`)
  }
  
  // Read all .cjs files
  const allFiles = fs.readdirSync(baseDir)
    .filter(file => file.endsWith('.cjs'))
  
  if (allFiles.length === 0) {
    error(`No .cjs test files found in: ${baseDir}`)
  }
  
  // Read content and extract dependencies
  const filesWithDeps = allFiles.map(file => {
    const filePath = path.join(baseDir, file)
    const content = fs.readFileSync(filePath, 'utf8')
    const dependencies = extractLocalDependencies(content, file)
    return { file, content, dependencies }
  })
  
  // Topologically sort files based on their require() dependencies
  const sortedFiles = topologicalSort(filesWithDeps)
  
  log(`Reading test code from ${sortedFiles.length} file(s): ${sortedFiles.join(', ')}`)
  
  // Combine all test files in dependency order
  const combinedCode = sortedFiles.map(file => {
    const fileData = filesWithDeps.find(f => f.file === file)
    // Strip out the require('./...') statements since we're combining files
    let contentWithoutLocalRequires = fileData.content.replace(
      /require\s*\(\s*['"]\.\/([\w-]+)(\.cjs)?['"]\s*\)\s*\n?/g,
      ''
    )

    const moduleExportIndex = contentWithoutLocalRequires.indexOf('module.exports')
    if (moduleExportIndex !== -1) {
      contentWithoutLocalRequires = contentWithoutLocalRequires.slice(0, moduleExportIndex)
    }

    const fileTestFunctions = parseAsyncFunctions(contentWithoutLocalRequires).map(fn => fn.name)
    const exportBlock = fileTestFunctions.length
      ? `\nObject.assign(globalThis, { ${fileTestFunctions.join(', ')} });\n`
      : '\n'
    return `// ===== From ${file} =====\n(() => {\n${contentWithoutLocalRequires}\n${exportBlock}})();\n`
  }).join('\n')
  
  return combinedCode
}

/**
 * Read package.json from installed addon
 */
function readAddonPackageJson(packageName, projectRoot) {
  const addonPath = path.join(projectRoot, 'node_modules', packageName)
  const pkgPath = path.join(addonPath, 'package.json')
  
  if (!fs.existsSync(pkgPath)) {
    error(`Package.json not found: ${pkgPath}`)
  }
  
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
}

/**
 * Extract the core test logic (everything except module.exports)
 */
function extractTestLogic(testCode) {
  // Remove the module.exports line and everything after it
  const lines = testCode.split('\n')
  const filteredLines = []
  
  for (const line of lines) {
    // Stop when we hit module.exports - don't include anything after this
    if (line.includes('module.exports')) {
      break
    }
    filteredLines.push(line)
  }
  
  // Remove trailing empty lines
  while (filteredLines.length > 0 && filteredLines[filteredLines.length - 1].trim() === '') {
    filteredLines.pop()
  }
  
  return filteredLines.join('\n')
}

/**
 * Extract individual test function names and their parameters from test code
 * Looks for async function declarations like: async function testFoo() {...}
 * Returns array of objects with parameter details
 */
function parseAsyncFunctions(testCode) {
  const functionRegex = /async\s+function\s+(\w+)\s*\(([^)]*)\)/g
  const functions = []
  let match
  
  while ((match = functionRegex.exec(testCode)) !== null) {
    const functionName = match[1]
    const paramsString = match[2].trim()
    
    // Exclude init and helper functions (starting with _)
    if (functionName !== 'init' && !functionName.startsWith('_')) {
      // Parse parameter names
      const rawParams = paramsString ? paramsString.split(',').map(p => p.trim()) : []
    const params = rawParams.map(p => p.split('=')[0].trim())
      
      // Detect parameter types
      const hasDirPathParam = params.includes('dirPath')
      const hasGetAssetPathParam = params.includes('getAssetPath')
      
      // Check for audioData/buffer parameter (indicates direct pre-test data usage)
      const hasAudioDataParam = params.some(p => 
        p === 'audioData' || 
        p === 'buffer' || 
        p.startsWith('audioData') ||
        p.startsWith('buffer')
      )

      const allowedParams = new Set([
        'dirPath',
        'getAssetPath',
        'preTestData',
        'options',
        'audioData',
        'buffer',
        'preTestDataBuffer'
      ])
      const hasUnknownParams = params.some(p => p.length > 0 && !allowedParams.has(p))
      
      functions.push({ 
        name: functionName, 
        params,
        hasDirPathParam,
        hasGetAssetPathParam,
        hasAudioDataParam,
        hasUnknownParams
      })
    }
  }
  
  return functions
}

function extractTestFunctions(testCode) {
  const functions = parseAsyncFunctions(testCode)
  const runnableFunctions = functions.filter(fn => !fn.hasUnknownParams)
  const skippedFunctions = functions.filter(fn => fn.hasUnknownParams)
  log(`Found ${functions.length} async function(s), using ${runnableFunctions.length}: ${runnableFunctions.map(f => f.name).join(', ')}`)
  if (skippedFunctions.length > 0) {
    log(`Skipping ${skippedFunctions.length} helper function(s) that require unsupported parameters: ${skippedFunctions.map(f => f.name).join(', ')}`)
  }
  return runnableFunctions
}

/**
 * Generate backend.cjs with injected test logic
 */
function generateBackend(testLogic, testFunctions, integrationFiles = []) {
  return `const { INIT, RUN_TEST } = require('./api.cjs')
const RPC = require('bare-rpc')
const fs = require('bare-fs')
const path = require('bare-path')
const ensureProcess = () => {
  if (typeof globalThis.process === 'undefined') {
    try {
      globalThis.process = require('bare-process')
    } catch (e) {
      console.warn('bare-process not available, some integration tests may fail:', e.message)
    }
  }
}
const testRuns = {}
function logRun(testName, stage, detail) {
  const timestamp = new Date().toISOString()
  if (!testRuns[testName]) {
    testRuns[testName] = { stages: [] }
  }
  testRuns[testName].stages.push({ stage, timestamp, detail })
  console.log(\`[TestRunner][\${timestamp}] \${testName} -> \${stage}\${detail ? ' :: ' + detail : ''}\`)
}
ensureProcess()

// ============================================
// STATIC INIT FUNCTIONALITY
// ============================================
// Global dirPath variable used by test functions
let dirPath = null

/**
 * Initialize the test environment
 * @param {string} path - The directory path for test assets
 * @param {Object} assets - Map of asset project paths to actual URIs
 * @returns {Promise<string>}
 */
async function init(path, assets = {}) {
  try {
    dirPath = path
    global.assetPaths = assets
    global.testDir = dirPath
    return 'INITIALIZED'
  } catch (error) {
    console.error('Error during initialization:', error)
    throw new Error(\`Init failed: \${error.message}\`)
  }
}

function getAssetPath(assetName) {
  const projectPath = \`../../testAssets/\${assetName}\`
  
  // For other assets, check the asset map first
  if (global.assetPaths && global.assetPaths[projectPath]) {
    // Remove file:// prefix if present and return the actual path
    return global.assetPaths[projectPath].replace('file://', '')
  }
  
  // Asset not found in manifest - throw clear error
  throw new Error(\`Asset not found in testAssets: \${assetName}. Make sure \${assetName} is in testAssets/ directory and rebuild the app.\`)
}

// ============================================
// END STATIC INIT FUNCTIONALITY
// ============================================

// ============================================
// INJECTED TEST CODE FROM ADDON
// ============================================
${testLogic}
// ============================================
// END INJECTED TEST CODE
// ============================================

const integrationModuleLoaders = {
${integrationFiles.filter(file => file && file.bundlePath).map(file => {
  return `  '${file.lookupKey}': () => require('${file.bundlePath}')`
}).join(',\n')}
}

async function loadBundledIntegrationModule(relativeModulePath, options = {}) {
  const loader = integrationModuleLoaders[relativeModulePath]
  if (!loader) {
    throw new Error(\`Integration module not found: \${relativeModulePath}\`)
  }
  
  // Load the test module (this registers tests with brittle and creates the runner)
  loader(options)
  
  // Get brittle runner AFTER loading (brittle creates it on first require)
  const runner = global[Symbol.for('brittle-runner')]
  
  if (!runner) {
    // No brittle runner - module loaded but doesn't use brittle
    return { modulePath: relativeModulePath, summary: { total: 0, passed: 0, failed: 0 } }
  }
  
  // Capture BOTH count and pass BEFORE running this module's tests
  // (brittle runner is a singleton with cumulative counts across all modules)
  const initialCount = runner.tests ? runner.tests.count : 0
  const initialPass = runner.tests ? runner.tests.pass : 0
  
  // Wait for tests to be registered and start
  let waited = 0
  const maxWait = 5000 // 5 seconds max to wait for tests to start
  while (runner.tests && runner.tests.count === initialCount && runner.next === null && waited < maxWait) {
    await new Promise(resolve => setTimeout(resolve, 50))
    waited += 50
  }
  
  // Now wait for all tests to complete
  if (runner.next !== null || (runner.tests && runner.tests.count > initialCount)) {
    while (runner.next !== null) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  
  const finalCount = runner.tests ? runner.tests.count : 0
  const finalPass = runner.tests ? runner.tests.pass : 0
  
  // Calculate PER-MODULE results (delta from before/after this module ran)
  // This is critical because brittle's runner accumulates counts globally
  const moduleTotal = finalCount - initialCount
  const modulePassed = finalPass - initialPass
  const moduleFailed = moduleTotal - modulePassed
  
  // Return per-module summary (not cumulative global counts)
  return { 
    modulePath: relativeModulePath,
    summary: {
      total: moduleTotal,
      passed: modulePassed,
      failed: moduleFailed
    }
  }
}

global.runIntegrationModule = async function(relativeModulePath, options = {}) {
  return loadBundledIntegrationModule(relativeModulePath, options)
}

// Map of test functions
const testFunctionMap = {
${testFunctions.map(fn => {
  const wrapperArgs = '(dirPathArg, getAssetPathArg, preTestData)'
  const fnRef = `globalThis['${fn.name}']`

  // Case 1: Function takes audioData/buffer directly (e.g., test_mic_transcription(audioData))
  if (fn.hasAudioDataParam && !fn.hasDirPathParam && !fn.hasGetAssetPathParam) {
    return `  '${fn.name}': ${wrapperArgs} => ${fnRef}(preTestData)`
  }

  // Case 2: Function has standard params (dirPath, getAssetPath) and optionally audio data
  const params = []
  if (fn.hasDirPathParam) {
    params.push('dirPathArg')
  }
  if (fn.hasGetAssetPathParam) {
    params.push('getAssetPathArg')
  }
  if (fn.hasAudioDataParam) {
    params.push('preTestData')
  }

  if (params.length > 0) {
    return `  '${fn.name}': ${wrapperArgs} => ${fnRef}(${params.join(', ')})`
  }

  // Case 3: No parameters - exposure only
  return `  '${fn.name}': ${wrapperArgs} => ${fnRef}()`
}).join(',\n')}
}

// RPC request handlers
async function handleInit(req) {
    try {
        const data = JSON.parse(req.data.toString('utf8'))
        const { dirPath: path, assetPaths } = data
        const result = await init(path, assetPaths || {})
        req.reply(result)
    } catch (error) {
        console.error('Init error:', error)
        req.reply(\`Error: \${error.message}\`)
    }
}

async function handleRunTest(req) {
    try {
        const data = JSON.parse(req.data.toString('utf8'))
        const { testName, preTestData } = data
        
        if (!testFunctionMap[testName]) {
            req.reply(JSON.stringify({ 
                success: false, 
                error: \`Test function '\${testName}' not found\` 
            }))
            return
        }
        
        logRun(testName, 'start')
        
        // Process preTestData - convert Buffer-like objects back to actual Buffers
        let processedPreTestData = preTestData
        if (preTestData && preTestData.type === 'Buffer' && Array.isArray(preTestData.data)) {
            // Reconstruct the Buffer from JSON representation
            processedPreTestData = Buffer.from(preTestData.data)
        }
        
        try {
            // Pass runtime context along with any pre-test payload to the test function
            const startedAt = Date.now()
            const result = await testFunctionMap[testName](dirPath, getAssetPath, processedPreTestData)
            const duration = Date.now() - startedAt
            logRun(testName, 'end', \`duration=\${duration}ms\`)
            
            // Handle result with summary
            const { summary } = result
            const allPassed = summary.failed === 0
            
            req.reply(JSON.stringify({ 
                success: allPassed,
                testName,
                summary,
                duration 
            }))
        } catch (error) {
            console.error(\`Test '\${testName}' failed:\`, error)
            logRun(testName, 'error', error.message)
            req.reply(JSON.stringify({ 
                success: false, 
                testName,
                error: error.message,
                stack: error.stack
            }))
        }
    } catch (error) {
        console.error('Run test error:', error)
        req.reply(JSON.stringify({ 
            success: false, 
            error: \`Failed to parse request: \${error.message}\` 
        }))
    }
}

// Initialize RPC server
const rpc = new RPC(BareKit.IPC, (req) => {
    switch (req.command) {
        case INIT:
            handleInit(req)
            break;
        case RUN_TEST:
            handleRunTest(req)
            break;
        default:
            req.reply(\`Unknown command: \${req.command}\`)
    }
})
`
}

/**
 * Extract dependencies from test code
 */
function extractTestDependencies(testCode) {
  const requireRegex = /require\(['"](@[^/]+\/[^'"]+|[^'"@]+)['"]\)/g
  const dependencies = new Set()
  let match
  
  while ((match = requireRegex.exec(testCode)) !== null) {
    const dep = match[1]
    // Skip bare built-ins and relative imports
    if (!dep.startsWith('.') && !dep.startsWith('bare-')) {
      dependencies.add(dep)
    }
  }
  
  return Array.from(dependencies)
}

/**
 * Install test dependencies
 */
function installTestDependencies(addonPackageJson, testDependencies, projectRoot) {
  const depsToInstall = []
  
  // Check devDependencies for required test deps
  if (addonPackageJson.devDependencies) {
    for (const dep of testDependencies) {
      if (addonPackageJson.devDependencies[dep]) {
        depsToInstall.push(`${dep}@${addonPackageJson.devDependencies[dep]}`)
      }
    }
  }
  
  // Check dependencies for required test deps
  if (addonPackageJson.dependencies) {
    for (const dep of testDependencies) {
      if (addonPackageJson.dependencies[dep]) {
        depsToInstall.push(`${dep}@${addonPackageJson.dependencies[dep]}`)
      }
    }
  }
  
  if (depsToInstall.length === 0) {
    log('No additional test dependencies needed')
    return
  }

  const missingDeps = depsToInstall.filter(dep => {
    const pkgName = extractPackageName(dep)
    try {
      require.resolve(pkgName, { paths: [projectRoot] })
      return false
    } catch (_) {
      return true
    }
  })

  if (missingDeps.length === 0) {
    log('All test dependencies already installed; skipping npm install')
    return
  }

  log(`Installing test dependencies: ${missingDeps.join(', ')}`)
  try {
    execSync(`npm install --legacy-peer-deps ${missingDeps.join(' ')}`, {
      cwd: projectRoot,
      stdio: 'inherit'
    })
  } catch (err) {
    log(`Warning: failed to install optional test dependencies (${missingDeps.join(', ')}). Continuing anyway.`)
  }
}

function extractPackageName(spec) {
  if (spec.startsWith('@')) {
    const secondAt = spec.indexOf('@', 1)
    if (secondAt === -1) return spec
    return spec.slice(0, secondAt)
  }
  const atIndex = spec.indexOf('@')
  return atIndex === -1 ? spec : spec.slice(0, atIndex)
}

/**
 * Copy test assets if they exist
 * 
 * First checks if addon has a media/ folder at root and copies those files
 * to test/mobile/testAssets/ to avoid duplication across addon libs.
 */
function copyTestAssets(testsDir, projectRoot, addonSource) {
  // Step 1: Check if addon has a media/ folder at root
  // This allows all addons to store media files in one standard location
  if (addonSource) {
    const addonMediaDir = path.join(addonSource, 'media')
    const testAssetsInTestDir = path.join(testsDir, 'testAssets')
    
    if (fs.existsSync(addonMediaDir)) {
      log(`Found media/ folder in addon root: ${addonMediaDir}`)
      log(`Copying media files to ${testAssetsInTestDir} to avoid duplication...`)
      
      // Create testAssets directory if it doesn't exist
      if (!fs.existsSync(testAssetsInTestDir)) {
        fs.mkdirSync(testAssetsInTestDir, { recursive: true })
      }
      
      // Copy media files to testAssets
      copyDirectoryRecursive(addonMediaDir, testAssetsInTestDir)
      log(`Media files copied from addon/media/ to test/mobile/testAssets/`)
    }
  }
  
  // Step 2: Copy testAssets from test/mobile/testAssets to app
  const testAssetsSource = path.join(testsDir, 'testAssets')
  const testAssetsTarget = path.join(projectRoot, 'testAssets')
  
  if (!fs.existsSync(testAssetsSource)) {
    // No assets provided in tests dir; skip copy without warning
    return { copied: false, source: null }
  }
  
  log('Copying test assets to app...')
  
  // Create target directory for testAssets (used by backend)
  if (fs.existsSync(testAssetsTarget)) {
    fs.rmSync(testAssetsTarget, { recursive: true })
  }
  fs.mkdirSync(testAssetsTarget, { recursive: true })
  copyDirectoryRecursive(testAssetsSource, testAssetsTarget)
  
  // Also copy to assets/ for Expo's asset pipeline
  const expoAssetsTarget = path.join(projectRoot, 'assets', 'testAssets')
  fs.mkdirSync(expoAssetsTarget, { recursive: true })
  copyDirectoryRecursive(testAssetsSource, expoAssetsTarget)
  
  log('Test assets copied successfully')
  return { copied: true, source: testAssetsSource }
}

/**
 * Generate shim files in backend/ that redirect requires to the installed addon package.
 * This allows integration tests to keep using relative paths like ../../index.js while
 * actual logic comes from node_modules/@scope/package.
 */
function generateAddonShimFiles(packageName, projectRoot) {
  const backendDir = path.join(projectRoot, 'backend')
  fs.mkdirSync(backendDir, { recursive: true })

  const indexShimPath = path.join(backendDir, 'index.js')
  const indexShim = `'use strict'

module.exports = require('${packageName}')
`
  fs.writeFileSync(indexShimPath, indexShim, 'utf8')

  const addonShimPath = path.join(backendDir, 'addon.js')
  const addonShim = `'use strict'

module.exports = require('${packageName}/addon.js')
`
  fs.writeFileSync(addonShimPath, addonShim, 'utf8')

  const bindingShimPath = path.join(backendDir, 'binding.js')
  const bindingShim = `'use strict'

module.exports = require('${packageName}/binding.js')
`
  fs.writeFileSync(bindingShimPath, bindingShim, 'utf8')

  const addonLoggingShimPath = path.join(backendDir, 'addonLogging.js')
  const addonLoggingShim = `'use strict'

module.exports = require('${packageName}/addonLogging.js')
`
  fs.writeFileSync(addonLoggingShimPath, addonLoggingShim, 'utf8')

  log('Generated addon shim files in backend/')
}

/**
 * Copy integration tests into backend/integration
 * Returns null if no integration directory exists
 */
function syncIntegrationTests(testsDir, projectRoot) {
  const testSourceRoot = path.resolve(path.join(testsDir, '..'))
  const integrationSourceDir = path.join(testSourceRoot, 'integration')

  if (!fs.existsSync(integrationSourceDir)) {
    log('No integration directory found adjacent to test/mobile (../integration). Skipping integration tests.')
    return null
  }

  const testTargetRoot = path.join(projectRoot, 'backend', 'test')
  fs.rmSync(testTargetRoot, { recursive: true, force: true })
  fs.mkdirSync(testTargetRoot, { recursive: true })
  copyDirectoryRecursive(testSourceRoot, testTargetRoot)
  log(`Copied test directory from ${testSourceRoot} to ${testTargetRoot}`)

  const integrationTargetDir = path.join(testTargetRoot, 'integration')
  return {
    sourceRoot: integrationSourceDir,
    targetRoot: integrationTargetDir,
    bundlePrefix: './test/integration/'
  }
}

function patchIntegrationUtilsForMobile(projectRoot) {
  const utilsPath = path.join(projectRoot, 'backend', 'test', 'integration', 'utils.js')
  if (!fs.existsSync(utilsPath)) {
    log('No test integration utils found to patch for mobile; skipping')
    return
  }

  const originalSnippet = `const modelDir = path.resolve(__dirname, '../model')`
  const replacementSnippet = `const writableRoot = global.testDir || process.cwd()
const modelDir = path.join(writableRoot, 'test', 'model')`

  const content = fs.readFileSync(utilsPath, 'utf8')
  if (!content.includes(originalSnippet)) {
    log('Integration utils already patched for mobile; skipping')
    return
  }

  const patched = content.replace(originalSnippet, replacementSnippet)
  fs.writeFileSync(utilsPath, patched, 'utf8')
  log('Patched integration utils to use mobile writable directory')
}

/**
 * Collect integration modules referenced by integration.auto.cjs
 */
function parseIntegrationAutoModules(integrationAutoPath) {
  if (!fs.existsSync(integrationAutoPath)) {
    return []
  }

  const integrationAutoDir = path.dirname(integrationAutoPath)
  const content = fs.readFileSync(integrationAutoPath, 'utf8')
  const regex = /runIntegrationModule\(\s*['"]([^'"]+)['"]/g
  const modules = new Map()
  let match

  while ((match = regex.exec(content)) !== null) {
    const lookupKey = match[1]
    const mapKey = lookupKey.replace(/\\/g, '/')
    const absolutePath = path.resolve(integrationAutoDir, lookupKey)
    if (!fs.existsSync(absolutePath)) {
      log(`Warning: integration test '${lookupKey}' not found at ${absolutePath}`)
      continue
    }
    modules.set(mapKey, {
      lookupKey,
      absolutePath
    })
  }

  return Array.from(modules.values())
}

/**
 * Collect integration modules referenced by integration.auto.cjs in the provided tests dir
 * Returns empty array if no integration tests are present
 */
function collectIntegrationModulesForTestsDir(testsDir, integrationCopyMeta) {
  // If no integration directory was copied, skip integration modules entirely
  if (!integrationCopyMeta) {
    log('No integration tests to process (integration directory not present)')
    return []
  }

  const integrationAutoPath = path.join(testsDir, 'integration.auto.cjs')

  if (!fs.existsSync(integrationAutoPath)) {
    log('No integration.auto.cjs found in test/mobile. Skipping integration tests.')
    return []
  }

  const { sourceRoot, targetRoot, bundlePrefix } = integrationCopyMeta

  const modules = parseIntegrationAutoModules(integrationAutoPath)

  if (modules.length === 0) {
    log('integration.auto.cjs found but no valid integration modules were detected')
    return []
  }

  const mapped = []

  for (const module of modules) {
    const relativePath = path.relative(sourceRoot, module.absolutePath)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      log(`Warning: ${module.lookupKey} lies outside copied integration source; skipping`)
      continue
    }

    const copiedPath = path.join(targetRoot, relativePath)
    if (!fs.existsSync(copiedPath)) {
      log(`Warning: copied integration file missing for ${module.lookupKey} at ${copiedPath}`)
      continue
    }

    const normalizedRelative = relativePath.split(path.sep).join('/')
    const bundlePath = `${bundlePrefix}${normalizedRelative}`

    mapped.push({
      lookupKey: module.lookupKey,
      bundlePath,
      absolutePath: copiedPath
    })
  }

  log(`Discovered ${mapped.length} integration module(s) to include`)
  return mapped
}

/**
 * Scan directory recursively and return all file paths
 * Excludes .gitignore and hidden files
 */
function scanDirectory(dir, baseDir = dir) {
  const files = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  
  for (const entry of entries) {
    // Skip .gitignore and hidden files
    if (entry.name.startsWith('.')) {
      continue
    }
    
    const fullPath = path.join(dir, entry.name)
    const relativePath = path.relative(baseDir, fullPath)
    
    if (entry.isDirectory()) {
      files.push(...scanDirectory(fullPath, baseDir))
    } else {
      files.push(relativePath)
    }
  }
  
  return files
}

/**
 * Generate asset manifest from testAssets directory
 */
function generateAssetManifest(projectRoot) {
  const testAssetsDir = path.join(projectRoot, 'testAssets')
  const outputFile = path.join(projectRoot, 'app', 'assetManifest.js')
  
  // Check if testAssets exists
  if (!fs.existsSync(testAssetsDir)) {
    log('No testAssets directory found, creating empty manifest')
    const emptyManifest = `// Auto-generated asset manifest
export const ASSET_FILES = []
`
    fs.writeFileSync(outputFile, emptyManifest, 'utf8')
    return
  }
  
  // Scan for all files
  const allFiles = scanDirectory(testAssetsDir)
   
  if (allFiles.length > 0) {
    log('Asset files to load:')
    allFiles.forEach(f => log(`  - ${f}`))
  }
  
  // Generate the manifest file
  const manifestContent = `// Auto-generated asset manifest
// This file is generated by scripts/build-test-app.js
// Do not edit manually!

export const ASSET_FILES = [
${allFiles.map(f => `  {
    projectPath: '../../testAssets/${f.replace(/\\/g, '/')}',
    modulePath: require('../assets/testAssets/${f.replace(/\\/g, '/')}')
  }`).join(',\n')}
]
`
  
  fs.writeFileSync(outputFile, manifestContent, 'utf8')
  log(`Generated asset manifest at: ${outputFile}`)
}

/**
 * Generate testConfig.js with list of test functions
 * Returns testConfigs for use in e2e test generation
 */
function generateTestConfig(testFunctions, projectRoot) {
  const configPath = path.join(projectRoot, 'app', 'testConfig.js')
  
  // Extract just the function names for the config
  const testFunctionNames = testFunctions.map(fn => fn.name)
  
  // Auto-detect tests that need pre-test configuration
  const testConfigs = {}
  
  for (const fn of testFunctions) {
    // If function takes audioData/buffer as parameter, it likely needs microphone recording
    if (fn.hasAudioDataParam && !fn.hasDirPathParam && !fn.hasGetAssetPathParam) {
      // Check if test name suggests microphone/recording
      if (fn.name.toLowerCase().includes('mic') || 
          fn.name.toLowerCase().includes('record') ||
          fn.name.toLowerCase().includes('audio')) {
        testConfigs[fn.name] = {
          preTest: {
            type: 'recordMicrophone',
            duration: 5000
          }
        }
        log(`  Auto-configured pre-test (recordMicrophone) for: ${fn.name}`)
      }
    }
  }
  
  // Generate TEST_CONFIG object
  const configEntriesStr = Object.entries(testConfigs).map(([name, config]) => {
    return `  '${name}': ${JSON.stringify(config, null, 4).replace(/^/gm, '  ').trim()}`
  }).join(',\n')
  
  const configContent = `// Auto-generated test configuration
// This file is generated by scripts/build-test-app.js
// Do not edit manually!

export const TEST_FUNCTIONS = ${JSON.stringify(testFunctionNames, null, 2)}

// Optional: Configuration for tests that need pre-test or post-test steps
// This is auto-generated based on test function signatures
export const TEST_CONFIG = {
${configEntriesStr || '  // No pre-test configurations detected'}
}
`
  
  fs.writeFileSync(configPath, configContent, 'utf8')
  log(`Generated test config at: ${configPath}`)
  
  // Return testConfigs so e2e test generation can filter out manual tests
  return testConfigs
}

/**
 * Generate app.test.js with individual test cases
 * Only generates tests for automated tests (excludes manual tests)
 */
function generateTestFile(testFunctions, manualTestConfigs, projectRoot) {
  const testFilePath = path.join(projectRoot, 'e2e', 'tests', 'app.test.js')
  
  // Extract just the function names for test generation
  // Filter out manual tests (those in manualTestConfigs)
  const testFunctionNames = testFunctions
    .map(fn => fn.name)
    .filter(name => !manualTestConfigs[name])
  
  if (testFunctionNames.length === 0) {
    log('No automated tests found, skipping e2e test generation')
  } else {
    log(`Generating e2e tests for ${testFunctionNames.length} automated test(s)`)
    testFunctionNames.forEach(name => log(`  - ${name}`))
  }
  
  const manualTestNames = Object.keys(manualTestConfigs)
  const manualTestsComment = manualTestNames.length > 0 
    ? `\n    // Manual tests (excluded from e2e): ${manualTestNames.join(', ')}\n`
    : ''
  
  const testContent = `const { expect, driver } = require("@wdio/globals");

describe('Runner', () => {
    //START TEST
    it('initialize app', async () => {
        const text = await getElementByText('INITIALIZED')

        await text.waitUntil(async () => {
            return await text.isDisplayed()
        }, {
            timeout: 10000,
            interval: 1000
        })

        expect(await text.isDisplayed()).toBe(true)
    })
${manualTestsComment}
    //GENERATED TESTS (AUTOMATED ONLY)
${testFunctionNames.map(testName => `
    it('${testName}', async () => {
        // Wait for test result to appear
        const passText = await getElementByText('${testName}: PASS')
        const failText = await getElementByText('${testName}: FAIL')
        
        // Wait for either pass or fail with a generous timeout (20 minutes for ML model download/inference)
        await driver.waitUntil(async () => {
            const passDisplayed = await passText.isDisplayed().catch(() => false)
            const failDisplayed = await failText.isDisplayed().catch(() => false)
            return passDisplayed || failDisplayed
        }, {
            timeout: 1200000,
            interval: 2000,
            timeoutMsg: 'Test ${testName} did not complete within 20 minutes'
        })
        
        // Check which one is displayed
        const passDisplayed = await passText.isDisplayed().catch(() => false)
        const failDisplayed = await failText.isDisplayed().catch(() => false)
        
        // Test should pass (not fail)
        expect(passDisplayed).toBe(true)
        expect(failDisplayed).toBe(false)
    })`).join('\n')}
    //END GENERATED TESTS
})


async function getElementByText(text) {
    if (driver.isAndroid) {
        return await driver.$(\`android=new UiSelector().textContains("\${text}")\`);
    }
    return await driver.$(\`-ios predicate string:label CONTAINS "\${text}"\`);
}
`
  
  fs.writeFileSync(testFilePath, testContent, 'utf8')
  log(`Generated test file at: ${testFilePath}`)
}

/**
 * Bundle the app using bare-pack
 */
function bundleApp(projectRoot) {
  log('Bundling app...')
  
  execSync('npm run bundle', {
    cwd: projectRoot,
    stdio: 'inherit'
  })
  
  log('App bundled successfully')
}

/**
 * Main execution
 */
function main() {
  log('Starting build process...')
  
  const { addonSource, isLocalPath, testsDir, packageName, usingDefaultTestsDir } = parseArgs()
  const projectRoot = path.resolve(__dirname, '..')
  
  // Only resolve to absolute path if it's a local path
  const addonSourcePath = isLocalPath ? path.resolve(addonSource) : addonSource
  
  log(`Addon source: ${addonSourcePath}`)
  log(`Project root: ${projectRoot}`)
  
  // Step 1: Install the addon package (whether directory, .tgz, or npm package)
  installAddonPackage(addonSourcePath, isLocalPath, projectRoot)
  
  // Step 2: Validate tests directory exists (if using default path)
  if (usingDefaultTestsDir) {
    if (!fs.existsSync(testsDir)) {
      error(`Mobile tests directory does not exist: ${testsDir}\n\n` +
            'The addon package does not include tests in its published version.\n' +
            'Please provide a tests directory as the second argument:\n' +
            '  node build-test-app.js <addon-path> <path-to-tests-dir>\n\n' +
            'Example:\n' +
            `  node build-test-app.js ${addonSource} ../path-to-addon-source/test/mobile`)
    }
    if (!fs.statSync(testsDir).isDirectory()) {
      error(`Tests path is not a directory: ${testsDir}`)
    }
    log(`Using default tests directory: ${testsDir}`)
  }
  
  // Step 3: Read test code (testsDir is required)
  const testCode = readTestCode(testsDir)
  
  // Step 4: Extract test logic
  const testLogic = extractTestLogic(testCode)
  
  // Step 5: Extract test function names
  const testFunctions = extractTestFunctions(testCode)
  
  // Step 6: Copy and discover integration modules (if present)
  const integrationCopyMeta = syncIntegrationTests(testsDir, projectRoot)
  const integrationFiles = collectIntegrationModulesForTestsDir(testsDir, integrationCopyMeta)
  const testDependencies = extractTestDependencies(testCode)
  log(`Test dependencies found: ${testDependencies.join(', ') || 'none'}`)
  
  // Generate shim files so relative requires (../../index.js, ../../addon.js) resolve to the installed addon package.
  generateAddonShimFiles(packageName, projectRoot)
  if (integrationCopyMeta) {
    patchIntegrationUtilsForMobile(projectRoot)
  }

  // Step 7: Read addon's package.json
  const addonPackageJson = readAddonPackageJson(packageName, projectRoot)

  const allTestDependencies = Array.from(new Set(testDependencies))
  
  // Step 8: Install test dependencies
  installTestDependencies(addonPackageJson, allTestDependencies, projectRoot)
  
  // Step 9: Generate backend.cjs
  const backendCode = generateBackend(testLogic, testFunctions, integrationFiles)
  const backendPath = path.join(projectRoot, 'backend', 'backend.cjs')
  fs.writeFileSync(backendPath, backendCode, 'utf8')
  log(`Generated backend.cjs at: ${backendPath}`)
  
  // Step 10: Copy test assets (including from addon/media/ if present)
  copyTestAssets(testsDir, projectRoot, addonSource)
  
  // Step 11: Generate asset manifest
  log('Generating asset manifest...')
  generateAssetManifest(projectRoot)
  
  // Step 12: Generate test config
  log('Generating test config...')
  const manualTestConfigs = generateTestConfig(testFunctions, projectRoot)
  
  // Step 13: Generate test file (only for automated tests)
  log('Generating e2e test file...')
  generateTestFile(testFunctions, manualTestConfigs, projectRoot)
  
  // Step 14: Bundle app
  bundleApp(projectRoot)
  
  log('✅ Build complete! You can now run the app with:')
  log('   npm run android')
  log('   npm run ios')
}

// Run the script
main()

