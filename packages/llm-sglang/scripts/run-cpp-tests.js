'use strict'

const path = require('path')
const { spawnSync } = require('child_process')

const buildDir = process.env.CPP_BUILD_DIR || 'build'
const cwd = path.resolve(__dirname, '..', buildDir, 'test', 'unit')
const result = spawnSync('./addon-test', [], {
  cwd,
  stdio: 'inherit'
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
