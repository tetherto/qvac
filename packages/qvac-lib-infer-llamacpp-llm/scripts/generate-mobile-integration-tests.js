'use strict'

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
  lines.push('const __FILTERED = { modulePath: \'filtered\', summary: { total: 0, passed: 0, failed: 0 } }')
  lines.push('')

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const fnName = toFunctionName(file)
    const relativePath = `../integration/${file}`
    lines.push(`async function ${fnName} (options = {}) { // eslint-disable-line no-unused-vars`)
    lines.push(`  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('${fnName}')) return __FILTERED`)
    lines.push(`  return runIntegrationModule('${relativePath}', options)`)
    lines.push('}')
    if (i < files.length - 1) {
      lines.push('')
    }
  }

  return `${lines.join('\n')}\n`
}

function validateGroups (functionNames) {
  if (!fs.existsSync(groupsFile)) {
    console.warn('[warn] test-groups.json not found — skipping split validation')
    return
  }
  const groups = JSON.parse(fs.readFileSync(groupsFile, 'utf-8'))
  const nameSet = new Set(functionNames)
  for (const [platform, splits] of Object.entries(groups)) {
    const covered = new Set(Object.values(splits).flat())
    const missing = functionNames.filter(n => !covered.has(n))
    const extra = [...covered].filter(n => !nameSet.has(n))
    if (missing.length) {
      throw new Error(
        '[' + platform + '] Tests not assigned to any group in test-groups.json:\n  ' +
        missing.join('\n  ') + '\nAdd them to a group in test/mobile/test-groups.json.'
      )
    }
    if (extra.length) {
      throw new Error(
        '[' + platform + '] test-groups.json references non-existent tests:\n  ' +
        extra.join('\n  ') + '\nRemove them or check for typos.'
      )
    }
  }
  console.log('Group coverage validated — all tests assigned for every platform.')
}

function main () {
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
