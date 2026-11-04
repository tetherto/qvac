#!/usr/bin/env node
// Pear e2e: runs @qvac/inference in the in-process Bare thread that
// `PearRuntime.run()` starts, on the latest pear-runtime and Bare from npm.
// The app in ./app is packed with its addons offloaded, as apps ship, and run
// outside the install tree.
//
// Usage: node e2e/pear/run.mjs [--inference <tarball> | --tarballs <dir>] [--keep]
//   --inference  @qvac/inference tarball (default: `npm pack` of the built package)
//   --tarballs   `release-train.mjs pack` output; uses its @qvac/inference
//   --keep       keep the temp directory
// Env: PEAR_RUNTIME_VERSION, BARE_RUNTIME_VERSION, BARE_PACK_VERSION (default
//      latest), PEAR_E2E_TIMEOUT_MS (default 900000), PEAR_E2E_CACHE_DIR

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(here, '..', '..')
const manifest = readJson(path.join(packageDir, 'package.json'))
const PREFIX = 'PEAR_E2E '

// Optional peers the app needs: the llama.cpp plugin imports langdetect-text.
const APP_PEERS = ['@qvac/llm-llamacpp', '@qvac/langdetect-text']

const REPORTED_PACKAGES = [
  'pear-runtime',
  'bare-runtime',
  'bare-pack',
  'bare-worker',
  'bare-thread',
  'bare-channel',
  'bare-module',
  '@qvac/inference',
  ...APP_PEERS
]

const { values: args } = parseArgs({
  options: {
    inference: { type: 'string' },
    tarballs: { type: 'string' },
    keep: { type: 'boolean', default: false }
  }
})

const pearRuntimeVersion = process.env.PEAR_RUNTIME_VERSION || 'latest'
const bareRuntimeVersion = process.env.BARE_RUNTIME_VERSION || 'latest'
const barePackVersion = process.env.BARE_PACK_VERSION || 'latest'
const timeoutMs = Number(process.env.PEAR_E2E_TIMEOUT_MS || 900_000)

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-pear-e2e-'))
const appDir = path.join(workDir, 'app')
const outDir = path.join(workDir, 'out')
const cacheDir = path.resolve(process.env.PEAR_E2E_CACHE_DIR || path.join(workDir, 'models'))
const modulesDir = path.join(appDir, 'node_modules')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function run(command, commandArgs, opts) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`)
  const { status, signal, error } = spawnSync(command, commandArgs, { stdio: 'inherit', ...opts })
  if (error) throw error
  if (status !== 0) throw new Error(`${command} exited with ${status ?? signal}`)
}

// On Windows npm is npm.cmd, which only runs through a shell. Quoting keeps
// cmd from reading `^` in ranges as an escape.
function npm(npmArgs, cwd) {
  if (process.platform !== 'win32') return run('npm', npmArgs, { cwd })
  run(
    'npm',
    npmArgs.map((arg) => `"${arg}"`),
    { cwd, shell: true }
  )
}

function packInference() {
  if (args.inference) return path.resolve(args.inference)
  if (args.tarballs) {
    const index = readJson(path.join(args.tarballs, 'tarballs.json'))
    return path.resolve(args.tarballs, index['@qvac/inference'])
  }

  if (!fs.existsSync(path.join(packageDir, 'dist', 'index.js'))) {
    throw new Error('No dist/. Run `npm run build` first or pass --inference.')
  }

  const packDir = path.join(workDir, 'pack')
  fs.mkdirSync(packDir)
  npm(['pack', '--ignore-scripts', '--pack-destination', packDir], packageDir)
  return path.join(packDir, fs.readdirSync(packDir)[0])
}

function installApp(inferenceTarball) {
  fs.cpSync(path.join(here, 'app'), appDir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules')
  })

  // Fresh dir and no lockfile: every dependency resolves from npm.
  npm(
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--ignore-scripts',
      `pear-runtime@${pearRuntimeVersion}`,
      `bare-runtime@${bareRuntimeVersion}`,
      `bare-pack@${barePackVersion}`,
      inferenceTarball,
      ...APP_PEERS.map((name) => `${name}@${manifest.peerDependencies[name]}`)
    ],
    appDir
  )

  console.log('Resolved versions:')
  for (const name of REPORTED_PACKAGES) {
    const file = path.join(modulesDir, name, 'package.json')
    console.log(`  ${name}@${fs.existsSync(file) ? readJson(file).version : 'not installed'}`)
  }
}

function packApp() {
  // Defer the optional peers the app does not install, as `qvac bundle sdk` does.
  const deferArgs = Object.keys(manifest.peerDependenciesMeta)
    .filter((name) => !APP_PEERS.includes(name))
    .flatMap((name) => ['--defer', name])

  run(
    process.execPath,
    [
      path.join(modulesDir, 'bare-pack', 'bin.js'),
      '--offload',
      ...deferArgs,
      '--out',
      path.join(outDir, 'app.bundle'),
      'main.js'
    ],
    { cwd: appDir }
  )
}

function runBundle() {
  // The binary itself, not the bin wrapper, so the timeout kill reaches it.
  const bare = createRequire(path.join(modulesDir, 'bare-runtime', 'package.json'))(
    'bare-runtime'
  )()
  fs.chmodSync(bare, 0o755) // npm may drop the exec bit; the wrapper restores it too
  console.log(`$ bare app.bundle ${cacheDir}`)

  return new Promise((resolve, reject) => {
    const child = spawn(bare, ['app.bundle', cacheDir], {
      cwd: outDir,
      stdio: ['ignore', 'pipe', 'inherit']
    })
    child.on('error', reject)
    child.stdout.setEncoding('utf8')

    let result = null
    let pending = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      const lines = (pending + chunk).split('\n')
      pending = lines.pop()
      for (const line of lines) {
        if (!line.startsWith(PREFIX)) continue
        try {
          const message = JSON.parse(line.slice(PREFIX.length))
          if (message.event === 'result') result = message
        } catch {}
      }
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut, result })
    })
  })
}

function check({ code, signal, timedOut, result }) {
  const failures = []

  if (timedOut) failures.push(`app did not exit within ${timeoutMs} ms`)
  if (code !== 0) failures.push(`app exited with ${code ?? signal}`)
  if (!result) failures.push('worker thread reported no result')
  else if (!result.ok) failures.push(`worker thread failed: ${result.error}`)

  return failures
}

let failures

try {
  installApp(packInference())
  packApp()
  failures = check(await runBundle())
} catch (err) {
  failures = [err.stack]
} finally {
  if (args.keep) console.log(`Kept ${workDir}`)
  else fs.rmSync(workDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('\nPear e2e failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log('\nPear e2e passed.')
