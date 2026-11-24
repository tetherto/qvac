'use strict'

const path = require('node:path')
const process = require('node:process')

function npmCommand(platform = process.platform, env = process.env, execPath = process.execPath) {
  if (platform !== 'win32') return { command: 'npm', prefix: [] }
  const cli = env.npm_execpath?.endsWith('npm-cli.js')
    ? env.npm_execpath
    : path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return { command: execPath, prefix: [cli] }
}

module.exports = npmCommand
