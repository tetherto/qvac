'use strict'

const fs = require('bare-fs')
const path = require('bare-path')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileDir = path.join(repoRoot, 'test', 'mobile')
const outputFile = path.join(mobileDir, 'integration.auto.cjs')

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
  lines.push('')
  lines.push('/* global runIntegrationModule */')
  lines.push('')

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const fnName = toFunctionName(file)
    const relativePath = `../integration/${file}`
    lines.push(`async function ${fnName} (options = {}) { // eslint-disable-line no-unused-vars`)
    lines.push(`  return runIntegrationModule('${relativePath}', options)`)
    lines.push('}')
    // Only add blank line between functions, not after the last one
    if (i < files.length - 1) {
      lines.push('')
    }
  }

  return `${lines.join('\n')}\n`
}

function main () {
  // Ensure mobile directory exists
  if (!fs.existsSync(mobileDir)) {
    fs.mkdirSync(mobileDir, { recursive: true })
  }

  const files = getIntegrationFiles()
  if (files.length === 0) {
    throw new Error(`No integration test files found inside ${integrationDir}`)
  }

  const content = buildFileContents(files)
  fs.writeFileSync(outputFile, content, 'utf8')
  console.log(`Generated ${outputFile} with ${files.length} integration runners.`)
}

if (require.main === module) {
  main()
}
