'use strict'

const fs = require('fs')
const { generateDeps, generateQuickstartContent } = require('./utils')
const {
  quickstartSectionTitle,
  quickstartSectionDescription,
  quickstartProjectName,
  quickstartPath,
  readmePath
} = require('./constants')

const quickstartCode = fs.readFileSync(quickstartPath, 'utf8')
const dependencies = generateDeps(quickstartCode)

const quickstartContent = generateQuickstartContent(
  quickstartCode,
  dependencies,
  quickstartSectionDescription,
  quickstartProjectName
)

// Read README.md
let readmeContent = fs.readFileSync(readmePath, 'utf8')

// Replace content inside ${quickstartSectionTitle} section
const quickstartRegex = new RegExp(
  `(## ${quickstartSectionTitle}\\s*\\n)([\\s\\S]*?)(\\n## |\\n$)`
)
readmeContent = readmeContent.replace(
  quickstartRegex,
  `$1${quickstartContent}$3`
)

// Save updated README
fs.writeFileSync(readmePath, readmeContent, 'utf8')

console.log('✅ README updated with Quickstart instructions and code snippet.')
