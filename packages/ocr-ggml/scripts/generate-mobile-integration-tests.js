'use strict'

// Scans test/integration for *.test.js files and generates a mobile
// wrapper at test/mobile/integration.auto.cjs. Each generated wrapper
// function loads one integration test module via the shared mobile
// integration runtime so the mobile test framework (qvac-test-addon-mobile)
// can invoke them individually.

const fs = require('bare-fs')
const path = require('bare-path')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileDir = path.join(repoRoot, 'test', 'mobile')
const outputFile = path.join(mobileDir, 'integration.auto.cjs')
const groupsFile = path.join(mobileDir, 'test-groups.json')

function getIntegrationFiles () {
  if (!fs.existsSync(integrationDir)) {
    throw new Error(`Integration directory not found: ${integrationDir}`)
  }

  return fs.readdirSync(integrationDir)
    .filter(entry => entry.endsWith('.test.js'))
    .sort()
}

function toFunctionName (fileName) {
  const base = fileName.replace(/\.js$/, '')
  const parts = base.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const suffix = parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')
  return `run${suffix}`
}

function buildFileContents (files) {
  const lines = []
  lines.push("'use strict'")
  lines.push("require('./integration-runtime.cjs')")
  lines.push('')
  lines.push('// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.')
  lines.push('// Each function mirrors a single file under test/integration/.')
  lines.push('// Functions are invoked dynamically by the mobile test runner framework.')
  lines.push('')
  lines.push('/* global runIntegrationModule */')
  lines.push('')
  lines.push('/* global __shouldRunTest */')
  lines.push('')
  lines.push("const __FILTERED = { modulePath: 'filtered', summary: { total: 0, passed: 0, failed: 0 } }")
  lines.push('')

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const fnName = toFunctionName(file)
    const relativePath = `../integration/${file}`
    lines.push(`async function ${fnName} (options = {}) { // eslint-disable-line no-unused-vars -- called dynamically by the mobile test runner via string lookup`)
    lines.push(`  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('${fnName}')) return __FILTERED`)
    lines.push(`  return runIntegrationModule('${relativePath}', options)`)
    lines.push('}')
    if (i < files.length - 1) {
      lines.push('')
    }
  }

  return `${lines.join('\n')}\n`
}

// Validates that every generated function name appears in at least one group
// in test-groups.json and that all group entries resolve to real functions.
// Supports nested format: { android: { group: [...] }, ios: { group: [...] }, perf_report_filter: "..." }
// Also supports legacy flat format: { perf: [...], regularA: [...], perf_report_filter: "..." }
function validateGroups (functionNames) {
  if (!fs.existsSync(groupsFile)) {
    console.warn('[warn] test-groups.json not found — skipping split validation')
    return
  }
  const groups = JSON.parse(fs.readFileSync(groupsFile, 'utf-8'))
  const nameSet = new Set(functionNames)
  const covered = new Set()

  for (const [key, value] of Object.entries(groups)) {
    if (key === 'perf_report_filter') continue
    if (typeof value === 'object' && !Array.isArray(value)) {
      // Nested format: { android: { groupName: [...] }, ios: { groupName: [...] } }
      for (const groupTests of Object.values(value)) {
        if (Array.isArray(groupTests)) {
          for (const name of groupTests) covered.add(name)
        }
      }
    } else if (Array.isArray(value)) {
      // Flat format (legacy): { groupName: [...] }
      for (const name of value) covered.add(name)
    } else {
      console.warn(`[warn] Unexpected value type for key '${key}' in test-groups.json — skipping`)
    }
  }

  const missing = functionNames.filter(n => !covered.has(n))
  const extra = [...covered].filter(n => !nameSet.has(n))

  if (missing.length) {
    throw new Error(
      'Tests not assigned to any group in test-groups.json:\n  ' +
      missing.join('\n  ') + '\nAdd them to a group in test/mobile/test-groups.json.'
    )
  }
  if (extra.length) {
    throw new Error(
      'test-groups.json references non-existent tests:\n  ' +
      extra.join('\n  ') + '\nRemove them or check for typos.'
    )
  }
  console.log('Group coverage validated — all tests assigned.')
}

function main () {
  if (!fs.existsSync(mobileDir)) {
    fs.mkdirSync(mobileDir, { recursive: true })
  }

  const files = getIntegrationFiles()
  if (files.length === 0) {
    throw new Error(`No integration test files found inside ${integrationDir}`)
  }

  const functionNames = files.map(toFunctionName)
  const content = buildFileContents(files)
  fs.writeFileSync(outputFile, content, 'utf8')
  console.log(`Generated ${outputFile} with ${files.length} integration runners.`)
  validateGroups(functionNames)
}

if (require.main === module) {
  main()
}
