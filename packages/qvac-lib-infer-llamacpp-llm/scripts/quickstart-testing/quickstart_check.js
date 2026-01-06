'use strict'

const { spawn, execSync } = require('child_process')
const process = require('process')
const fs = require('fs')
const { generateDeps } = require('./utils')
const { quickstartPath } = require('./constants')

const quickstartCode = fs.readFileSync(quickstartPath, 'utf8')
const dependencies = generateDeps(quickstartCode)

// install dependencies other than @qvac/llm-llamacpp no need now that we have the prebuilds in CI
if (dependencies.size > 0) {
  try {
    console.log('Installing dependencies...')
    const output = execSync(
      `npm install ${Array.from(dependencies).filter(dep => dep !== '@qvac/llm-llamacpp').join(' ')}`
    )
    console.log(output.toString())
  } catch (error) {
    console.error('Error installing dependencies:', error)
    process.exit(1)
  }
}

// run quickstart
const child = spawn('bare', [quickstartPath], { shell: false, stdio: 'inherit' })

child.on('close', (code) => {
  if (code === 0) {
    console.log('Quickstart test finished successfully')
    process.exit(0)
  } else {
    console.log('Quickstart test failed')
    process.exit(1)
  }
})
