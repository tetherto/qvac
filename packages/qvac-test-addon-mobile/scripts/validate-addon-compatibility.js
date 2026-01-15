#!/usr/bin/env node

'use strict'

/**
 * Addon Compatibility Validation Script
 * 
 * This script validates that the qvac-test-addon-mobile framework can successfully
 * build test apps for registered addons. Run this before submitting PRs to ensure
 * your changes don't break existing addon compatibility.
 * 
 * Usage:
 *   node scripts/validate-addon-compatibility.js [options]
 * 
 * Options:
 *   --addon <name>     Test specific addon only (by package name or repo name)
 *   --local <path>     Test against a local addon directory
 *   --skip-bundle      Skip the bundling step (faster validation)
 *   --verbose          Show detailed output
 *   --help             Show this help message
 * 
 * Examples:
 *   # Test all registered addons
 *   node scripts/validate-addon-compatibility.js
 * 
 *   # Test specific addon
 *   node scripts/validate-addon-compatibility.js --addon @qvac/llm-llamacpp
 * 
 *   # Test local addon directory
 *   node scripts/validate-addon-compatibility.js --local ../qvac-lib-infer-llamacpp-llm
 */

const fs = require('fs')
const path = require('path')
const { execSync, spawnSync } = require('child_process')

const projectRoot = path.resolve(__dirname, '..')
const registryPath = path.join(projectRoot, '.github', 'addon-registry.json')

// Colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  bold: '\x1b[1m'
}

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`)
}

function logSection(title) {
  console.log('')
  log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'blue')
  log(`  ${title}`, 'bold')
  log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'blue')
}

function parseArgs() {
  const args = process.argv.slice(2)
  const options = {
    addon: null,
    local: null,
    skipBundle: false,
    verbose: false,
    help: false
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--addon' && args[i + 1]) {
      options.addon = args[++i]
    } else if (arg === '--local' && args[i + 1]) {
      options.local = path.resolve(args[++i])
    } else if (arg === '--skip-bundle') {
      options.skipBundle = true
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    }
  }

  return options
}

function showHelp() {
  console.log(`
Addon Compatibility Validation Script

Usage:
  node scripts/validate-addon-compatibility.js [options]

Options:
  --addon <name>     Test specific addon only (by package name or repo name)
  --local <path>     Test against a local addon directory
  --skip-bundle      Skip the bundling step (faster validation)
  --verbose          Show detailed output
  --help             Show this help message

Examples:
  # Test all registered addons
  node scripts/validate-addon-compatibility.js

  # Test specific addon
  node scripts/validate-addon-compatibility.js --addon @qvac/llm-llamacpp

  # Test local addon directory
  node scripts/validate-addon-compatibility.js --local ../qvac-lib-infer-llamacpp-llm
`)
}

function loadRegistry() {
  if (!fs.existsSync(registryPath)) {
    log(`❌ Addon registry not found at: ${registryPath}`, 'red')
    process.exit(1)
  }

  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  } catch (error) {
    log(`❌ Failed to parse addon registry: ${error.message}`, 'red')
    process.exit(1)
  }
}

function findLocalAddonPath(addonName) {
  // Common locations to search for addons
  const searchPaths = [
    path.join(projectRoot, '..', addonName),
    path.join(projectRoot, '..', addonName.replace('@qvac/', 'qvac-lib-')),
    path.join(projectRoot, '..', addonName.replace('@qvac/', '')),
    path.join(projectRoot, 'node_modules', addonName)
  ]

  // Also check if the addon name contains repo-like pattern
  const repoMatches = [
    'qvac-lib-infer-llamacpp-llm',
    'qvac-lib-infer-whispercpp'
  ]

  for (const match of repoMatches) {
    if (addonName.includes('llm') || addonName.includes('llama')) {
      searchPaths.push(path.join(projectRoot, '..', match))
    }
    if (addonName.includes('whisper') || addonName.includes('transcription')) {
      searchPaths.push(path.join(projectRoot, '..', match))
    }
  }

  for (const searchPath of searchPaths) {
    if (fs.existsSync(searchPath) && fs.existsSync(path.join(searchPath, 'package.json'))) {
      return searchPath
    }
  }

  return null
}

function validateAddonStructure(addonPath) {
  const issues = []

  // Check package.json
  const pkgPath = path.join(addonPath, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    issues.push('Missing package.json')
    return { valid: false, issues }
  }

  // Check test/mobile directory
  const testMobilePath = path.join(addonPath, 'test', 'mobile')
  if (!fs.existsSync(testMobilePath)) {
    issues.push('Missing test/mobile directory')
    return { valid: false, issues }
  }

  // Check for .cjs test files
  const cjsFiles = fs.readdirSync(testMobilePath).filter(f => f.endsWith('.cjs'))
  if (cjsFiles.length === 0) {
    issues.push('No .cjs test files in test/mobile')
    return { valid: false, issues }
  }

  return {
    valid: true,
    issues,
    testFiles: cjsFiles,
    hasIntegration: fs.existsSync(path.join(addonPath, 'test', 'integration')),
    hasTestAssets: fs.existsSync(path.join(testMobilePath, 'testAssets'))
  }
}

function runBuildScript(addonPath, options) {
  const buildScript = path.join(projectRoot, 'scripts', 'build-test-app.js')
  const testMobilePath = path.join(addonPath, 'test', 'mobile')

  log(`\n🏗️  Running build script...`, 'blue')

  try {
    // Prepare environment - install dependencies first if needed
    if (!fs.existsSync(path.join(projectRoot, 'node_modules'))) {
      log(`   Installing framework dependencies...`, 'gray')
      execSync('npm install', { cwd: projectRoot, stdio: options.verbose ? 'inherit' : 'pipe' })
    }

    // Run the build script
    const cmd = `node "${buildScript}" "${addonPath}" "${testMobilePath}"`
    
    if (options.verbose) {
      execSync(cmd, { cwd: projectRoot, stdio: 'inherit' })
    } else {
      execSync(cmd, { cwd: projectRoot, stdio: 'pipe' })
    }

    // Verify generated files
    const generatedFiles = [
      'backend/backend.cjs',
      'backend/api.cjs',
      'app/testConfig.js',
      'app/assetManifest.js',
      'e2e/tests/app.test.js'
    ]

    if (!options.skipBundle) {
      generatedFiles.push('backend/app.bundle')
    }

    const missingFiles = generatedFiles.filter(f => !fs.existsSync(path.join(projectRoot, f)))
    
    if (missingFiles.length > 0) {
      return {
        success: false,
        error: `Missing generated files: ${missingFiles.join(', ')}`
      }
    }

    // Read generated test config
    const testConfigPath = path.join(projectRoot, 'app', 'testConfig.js')
    const testConfigContent = fs.readFileSync(testConfigPath, 'utf8')
    const testFunctionMatch = testConfigContent.match(/TEST_FUNCTIONS = \[([\s\S]*?)\]/)
    
    let testCount = 0
    if (testFunctionMatch) {
      const functions = testFunctionMatch[1].match(/"[^"]+"/g)
      testCount = functions ? functions.length : 0
    }

    return {
      success: true,
      testCount,
      generatedFiles
    }

  } catch (error) {
    return {
      success: false,
      error: error.message
    }
  }
}

function cleanupGeneratedFiles() {
  // Clean up generated files to restore project state
  const filesToClean = [
    'backend/backend.cjs',
    'backend/app.bundle',
    'backend/index.js',
    'backend/addon.js',
    'backend/binding.js',
    'backend/addonLogging.js',
    'backend/test',
    'app/testConfig.js',
    'app/assetManifest.js',
    'e2e/tests/app.test.js',
    'testAssets',
    'assets/testAssets'
  ]

  for (const file of filesToClean) {
    const fullPath = path.join(projectRoot, file)
    if (fs.existsSync(fullPath)) {
      try {
        const stats = fs.statSync(fullPath)
        if (stats.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true })
        } else {
          fs.unlinkSync(fullPath)
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

async function validateAddon(addonInfo, options) {
  const { name, local } = addonInfo
  
  logSection(`Testing: ${name}`)

  // Find addon path
  let addonPath = local || findLocalAddonPath(name)
  
  if (!addonPath) {
    log(`❌ Could not find addon locally: ${name}`, 'red')
    log(`   Searched in parent directory and node_modules`, 'gray')
    log(`   Use --local <path> to specify addon location`, 'gray')
    return { addon: name, success: false, error: 'Addon not found locally' }
  }

  log(`📁 Found addon at: ${addonPath}`, 'gray')

  // Validate addon structure
  log(`\n🔍 Validating addon structure...`, 'blue')
  const validation = validateAddonStructure(addonPath)
  
  if (!validation.valid) {
    log(`❌ Invalid addon structure:`, 'red')
    validation.issues.forEach(issue => log(`   - ${issue}`, 'red'))
    return { addon: name, success: false, error: validation.issues.join(', ') }
  }

  log(`   ✅ Structure valid`, 'green')
  log(`   📄 Test files: ${validation.testFiles.length}`, 'gray')
  log(`   📦 Integration tests: ${validation.hasIntegration ? 'yes' : 'no'}`, 'gray')
  log(`   🗂️  Test assets: ${validation.hasTestAssets ? 'yes' : 'no'}`, 'gray')

  // Clean up any previous generated files
  cleanupGeneratedFiles()

  // Run build script
  const buildResult = runBuildScript(addonPath, options)

  if (!buildResult.success) {
    log(`\n❌ Build failed: ${buildResult.error}`, 'red')
    return { addon: name, success: false, error: buildResult.error }
  }

  log(`\n✅ Build successful!`, 'green')
  log(`   📋 Test functions extracted: ${buildResult.testCount}`, 'gray')

  // Clean up
  cleanupGeneratedFiles()

  return { addon: name, success: true, testCount: buildResult.testCount }
}

async function main() {
  const options = parseArgs()

  if (options.help) {
    showHelp()
    process.exit(0)
  }

  console.log('')
  log('╔═══════════════════════════════════════════════════════════╗', 'blue')
  log('║     QVAC Test Addon Mobile - Compatibility Validator      ║', 'blue')
  log('╚═══════════════════════════════════════════════════════════╝', 'blue')

  // Load registry
  const registry = loadRegistry()
  log(`\n📋 Addon Registry: ${registry.addons.length} addon(s) registered`, 'gray')

  // Determine which addons to test
  let addonsToTest = []

  if (options.local) {
    // Test local addon
    const pkgPath = path.join(options.local, 'package.json')
    if (!fs.existsSync(pkgPath)) {
      log(`❌ No package.json found at: ${options.local}`, 'red')
      process.exit(1)
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    addonsToTest.push({ name: pkg.name, local: options.local })
  } else if (options.addon) {
    // Filter to specific addon
    const found = registry.addons.find(a => 
      a.name === options.addon || 
      a.repository.includes(options.addon)
    )
    if (!found) {
      log(`❌ Addon not found in registry: ${options.addon}`, 'red')
      log(`   Registered addons:`, 'gray')
      registry.addons.forEach(a => log(`     - ${a.name}`, 'gray'))
      process.exit(1)
    }
    addonsToTest.push({ name: found.name })
  } else {
    // Test all registered addons
    addonsToTest = registry.addons.map(a => ({ name: a.name }))
  }

  log(`\n🎯 Testing ${addonsToTest.length} addon(s)`, 'blue')

  // Run validation for each addon
  const results = []
  for (const addon of addonsToTest) {
    const result = await validateAddon(addon, options)
    results.push(result)
  }

  // Summary
  logSection('VALIDATION SUMMARY')

  const passed = results.filter(r => r.success)
  const failed = results.filter(r => !r.success)

  console.log('')
  log(`Total addons tested: ${results.length}`, 'bold')
  log(`  ✅ Passed: ${passed.length}`, 'green')
  log(`  ❌ Failed: ${failed.length}`, failed.length > 0 ? 'red' : 'gray')

  if (passed.length > 0) {
    console.log('')
    log('Passed:', 'green')
    passed.forEach(r => {
      log(`  ✅ ${r.addon} (${r.testCount} tests)`, 'green')
    })
  }

  if (failed.length > 0) {
    console.log('')
    log('Failed:', 'red')
    failed.forEach(r => {
      log(`  ❌ ${r.addon}: ${r.error}`, 'red')
    })
  }

  console.log('')

  if (failed.length > 0) {
    log('⚠️  Some compatibility checks failed. Please fix before submitting PR.', 'yellow')
    process.exit(1)
  } else {
    log('✅ All compatibility checks passed!', 'green')
    process.exit(0)
  }
}

main().catch(error => {
  log(`\n❌ Unexpected error: ${error.message}`, 'red')
  if (error.stack) {
    log(error.stack, 'gray')
  }
  process.exit(1)
})

