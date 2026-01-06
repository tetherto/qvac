'use strict'

const fs = require('fs')
const {
  quickstartPath,
  readmePath,
  quickstartSectionDescription,
  quickstartProjectName,
  quickstartSectionTitle
} = require('./constants')
const { generateDeps, generateQuickstartContent } = require('./utils')
const { execSync } = require('child_process')

const quickstartCode = fs.readFileSync(quickstartPath, 'utf8')
const dependencies = generateDeps(quickstartCode)
const quickstartContent = generateQuickstartContent(
  quickstartCode,
  dependencies,
  quickstartSectionDescription,
  quickstartProjectName
)
const readmeContent = fs.readFileSync(readmePath, 'utf8')

// Note: this git diff approach only makes sense in the CI, please dont use it in local
// Replace content inside ${quickstartSectionTitle} section
const quickstartRegex = new RegExp(
  `(## ${quickstartSectionTitle}\\s*\\n)([\\s\\S]*?)(\\n## |\\n$)`
)

const updatedReadmeContent = readmeContent.replace(
  quickstartRegex,
  `$1${quickstartContent}$3`
)

// Save updated README
fs.writeFileSync(readmePath, updatedReadmeContent, 'utf8')

// check diff
const output = execSync(`git --no-pager diff ${readmePath}`)
if (output && output.toString().trim() !== '') {
  console.log('='.repeat(100))
  console.log('Outputing diff for debugging')
  console.log('-'.repeat(100))
  console.log(output.toString())
  console.log('='.repeat(100))
  console.log('\n\nQuickstart Section of the README is outdated use npm run update:quickstart-section to update the README')
  process.exit(1)
} else {
  console.log('Quickstart Section of the README is up to date')
  process.exit(0)
}
