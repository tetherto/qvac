#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cliEntry = require.resolve('@qvac/qvac-cli')

const child = spawn(process.execPath, [cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env
})

child.on('exit', (code) => {
  process.exit(code ?? 0)
})

child.on('error', (err) => {
  console.error('Failed to start @qvac/qvac-cli:', err.message)
  process.exit(1)
})
