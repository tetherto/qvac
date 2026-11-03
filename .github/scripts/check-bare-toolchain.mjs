#!/usr/bin/env node
/**
 * Checks for the bare toolchain locked in .github/bare-toolchain.
 *
 *   drift        Warn when npm publishes a newer release of a watched package.
 *                Always exits 0 once npm answers: a newer release is a signal
 *                to review, not a failure. With --report <file>, writes the
 *                tracking issue body there.
 *   verify-path  Fail when bare-make, clang or llvm-profdata on PATH is not
 *                the one in the lock's node_modules/.bin, i.e. install.mjs did
 *                not take effect.
 *
 * Usage:
 *   node .github/scripts/check-bare-toolchain.mjs drift [--report <file>]
 *   node .github/scripts/check-bare-toolchain.mjs verify-path
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  PATH_TOOLS,
  WATCHED,
  driftKey,
  findDrift,
  findOnPath,
  issueBody,
  lockedVersions,
  pathMismatches,
  reportedVersion,
} from './lib/bare-toolchain.mjs'

const LOCKFILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'bare-toolchain', 'package-lock.json')
// npm and the tool shims are .cmd files on Windows, which spawn only through a shell.
const shell = process.platform === 'win32'

function readLocked() {
  return lockedVersions(JSON.parse(readFileSync(LOCKFILE, 'utf8')))
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

export function latestVersion(name) {
  const result = spawnSync('npm', ['view', name, 'version'], { encoding: 'utf8', shell })
  if (result.status !== 0) {
    throw new Error(`npm view ${name} failed:\n${result.stderr || result.stdout}`)
  }
  const version = result.stdout.trim().split('\n').filter(Boolean).pop()
  if (!version) throw new Error(`npm view ${name} returned no version`)
  return version
}

function drift(argv) {
  let report = ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report' && argv[i + 1]) {
      report = argv[++i]
    } else {
      throw new Error(`unknown argument: ${argv[i]}`)
    }
  }

  const locked = readLocked()
  const latest = Object.fromEntries(WATCHED.map((name) => [name, latestVersion(name)]))
  const found = findDrift(locked, latest)

  output('drift', found.length > 0 ? 'true' : 'false')
  output('key', driftKey(found))
  if (found.length === 0) {
    console.log('The locked bare toolchain is the latest on npm.')
    summary('The locked bare toolchain is the latest on npm.')
    return
  }

  const body = issueBody(found)
  for (const { name, locked: version, latest: newer } of found) {
    console.log(`::warning file=.github/bare-toolchain/package-lock.json::${name} ${newer} is published; the lockfile pins ${version}`)
  }
  summary(body)
  if (report) writeFileSync(report, body)
}

function verifyPath() {
  const bin = join(dirname(LOCKFILE), 'node_modules', '.bin')
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const found = {}
  let failed = false
  for (const tool of PATH_TOOLS) {
    found[tool] = findOnPath(tool, {
      path: process.env[pathKey] ?? '',
      pathext: process.env.PATHEXT ?? '',
      platform: process.platform,
      exists: existsSync,
    })
    const result = spawnSync(tool, ['--version'], { encoding: 'utf8', shell })
    const version = result.status === 0 ? reportedVersion(result.stdout) : null
    console.log(`${tool}: ${found[tool] ?? 'not found'} (${version ?? 'does not run'})`)
    if (found[tool] && result.status !== 0) {
      console.log(`::error::${tool} at ${found[tool]} does not run`)
      failed = true
    }
  }
  for (const { tool, actual } of pathMismatches(bin, found, process.platform)) {
    console.log(`::error::${tool} on PATH is ${actual ?? 'missing'}, not the locked one in ${bin}`)
    failed = true
  }
  if (failed) process.exitCode = 1
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'drift') return drift(rest)
  if (command === 'verify-path' && rest.length === 0) return verifyPath()
  throw new Error('usage: check-bare-toolchain.mjs drift [--report <file>] | verify-path')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
