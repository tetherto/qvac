#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const eqIdx = token.indexOf('=')
    if (eqIdx !== -1) {
      out[token.slice(2, eqIdx)] = token.slice(eqIdx + 1)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

function runOrExit (command, args) {
  const result = spawnSync(command, args, {
    cwd: __dirname,
    stdio: 'inherit',
    env: process.env
  })
  if (result.error) {
    console.error(result.error.message || String(result.error))
    process.exit(1)
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status)
  }
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
}

const rawArgs = process.argv.slice(2)
const parsed = parseArgs(rawArgs)
const models = typeof parsed.models === 'string' ? parsed.models.trim() : ''

const prepArgs = [path.resolve(__dirname, 'prepare-models.js'), '--target', 'addon']
if (models) prepArgs.push('--models', models)
runOrExit(process.execPath, prepArgs)

runOrExit('bare', [path.resolve(__dirname, 'llm-parameter-sweep.js'), ...rawArgs])
