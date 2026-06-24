#!/usr/bin/env node
'use strict'

// Clones and builds llama-mtmd-cli from fabric (qvac fork) and/or
// upstream (ggml-org/llama.cpp). Writes cli-sources-resolved.json
// consumed by the orchestrator at benchmark time.
//
// Usage:
//   node scripts/build-cli-sources.js [--sources=fabric,upstream]
//       [--fabric-ref=v8189.0.2] [--upstream-ref=b8189]
//       [--backend=cpu|gpu] [--builds-dir=cli-builds] [--force-rebuild]
//
// --backend=gpu adds the platform-appropriate GGML accelerator flag
// (Vulkan on linux/win, Metal on darwin) so the CLI legs go through
// the same GPU code path as the addon's qvac-fabric prebuild.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync, execFileSync } = require('child_process')

const CLI_SOURCES = require('./cli-source-config')

// Vendored into the benchmark folder (was vlm-performance/scripts/), so the build
// outputs (cli-builds/, cli-sources-resolved.json) live in this dir.
const BENCH_DIR = __dirname
const DEFAULT_BUILDS_DIR = path.join(BENCH_DIR, 'cli-builds')
const RESOLVED_PATH = path.join(BENCH_DIR, 'cli-sources-resolved.json')
const BINARY_NAME = os.platform() === 'win32' ? 'llama-mtmd-cli.exe' : 'llama-mtmd-cli'

function log (...args) { console.log('[build-cli-sources]', ...args) }
function logErr (...args) { console.error('[build-cli-sources]', ...args) }

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const eq = t.indexOf('=')
    if (eq !== -1) { out[t.slice(2, eq)] = t.slice(eq + 1); continue }
    const k = t.slice(2)
    const n = argv[i + 1]
    if (!n || n.startsWith('--')) { out[k] = true } else { out[k] = n; i++ }
  }
  return out
}

function which (cmd) {
  try {
    const r = execSync(os.platform() === 'win32' ? `where ${cmd}` : `which ${cmd}`, {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
    })
    return r.trim().split('\n')[0].trim()
  } catch { return null }
}

function validatePrereqs () {
  const cmake = which('cmake')
  if (!cmake) throw new Error('cmake not found on PATH — install cmake >= 3.14')

  const git = which('git')
  if (!git) throw new Error('git not found on PATH')

  // On Windows, MSVC's cl.exe is normally not on PATH outside a
  // Developer Command Prompt; cmake locates it via vswhere/registry
  // and the Visual Studio generator. Other workflows in this repo
  // (cpp-tests-*.yml) rely on that and only set CMAKE_GENERATOR.
  // Skip the PATH-based compiler check there.
  let cc = null
  if (os.platform() !== 'win32') {
    cc = which('cc') || which('clang') || which('gcc')
    if (!cc) throw new Error('No C/C++ compiler found — install clang or gcc')
  }

  log(`cmake: ${cmake}`)
  log(`git:   ${git}`)
  log(`cc:    ${cc || '(deferred to cmake/MSVC)'}`)
}

function resolveRemoteSha (repo, ref) {
  try {
    const out = execFileSync('git', ['ls-remote', repo, ref], {
      encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore']
    })
    const match = out.match(/^([0-9a-f]{40})/)
    return match ? match[1] : null
  } catch { return null }
}

function cacheKey (sourceKey, sha, backend) {
  return `${sourceKey}-${os.platform()}-${os.arch()}-${backend}-${sha.slice(0, 12)}`
}

// Backend-specific cmake flag overlay. We merge these onto the
// per-source CPU flags so the GPU code paths get compiled in. Vulkan
// is chosen on linux/win to match the addon's qvac-fabric build
// (which links the Vulkan ggml backend); macOS uses Metal natively.
function backendCmakeFlags (backend) {
  if (backend !== 'gpu') return {}
  if (os.platform() === 'darwin') {
    return { GGML_METAL: 'ON' }
  }
  return { GGML_VULKAN: 'ON' }
}

function buildOne (sourceKey, sourceConfig, buildsDir, forceRebuild, backend) {
  log(`--- ${sourceKey} (${backend}) ---`)
  log(`repo: ${sourceConfig.repo}`)
  log(`ref:  ${sourceConfig.ref}`)

  const remoteSha = resolveRemoteSha(sourceConfig.repo, sourceConfig.ref)
  if (!remoteSha) {
    throw new Error(`Could not resolve ref '${sourceConfig.ref}' from ${sourceConfig.repo}`)
  }
  log(`resolved SHA: ${remoteSha.slice(0, 12)}`)

  const mergedFlags = { ...sourceConfig.cmakeFlags, ...backendCmakeFlags(backend) }

  const key = cacheKey(sourceKey, remoteSha, backend)
  const cacheDir = path.join(buildsDir, key)
  const binaryPath = path.join(cacheDir, BINARY_NAME)
  const provenancePath = path.join(cacheDir, 'provenance.json')

  if (!forceRebuild && fs.existsSync(binaryPath)) {
    log(`cache hit: ${binaryPath}`)
    const provenance = fs.existsSync(provenancePath)
      ? JSON.parse(fs.readFileSync(provenancePath, 'utf8'))
      : null
    return { binaryPath, commitSha: remoteSha, ref: sourceConfig.ref, label: `${sourceConfig.label}@${sourceConfig.ref}`, provenance }
  }

  const tmpDir = path.join(os.tmpdir(), `vlm-bench-build-${sourceKey}-${Date.now()}`)
  log(`cloning into ${tmpDir}`)

  try {
    execFileSync('git', ['clone', '--depth', '1', '-b', sourceConfig.ref, sourceConfig.repo, tmpDir], {
      stdio: 'inherit', timeout: 120000
    })

    const localSha = execFileSync('git', ['-C', tmpDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 5000
    }).trim()

    const cmakeDefines = Object.entries(mergedFlags)
      .map(([k, v]) => `-D${k}=${v}`)

    const buildDir = path.join(tmpDir, 'build')
    const nproc = os.cpus().length

    log(`configuring cmake (${Object.keys(mergedFlags).length} flags, backend=${backend})`)
    const configArgs = ['-B', buildDir, ...cmakeDefines, tmpDir]
    execFileSync('cmake', configArgs, {
      stdio: 'inherit',
      timeout: 120000,
      cwd: tmpDir
    })

    log(`building llama-mtmd-cli (${nproc} threads)`)
    // Multi-config generators (Visual Studio, Xcode, Ninja Multi-Config)
    // ignore CMAKE_BUILD_TYPE at configure-time and need --config at
    // build-time; single-config generators (Unix Makefiles, plain Ninja)
    // reject --config. Detect via CMAKE_GENERATOR env (set by the
    // workflow on Windows; unset elsewhere, where the default generator
    // is single-config).
    const generator = process.env.CMAKE_GENERATOR || ''
    const isMultiConfig = /^(Visual Studio|Xcode|Ninja Multi-Config)/.test(generator)
    const buildArgs = ['--build', buildDir, '--target', 'llama-mtmd-cli', '-j', String(nproc)]
    if (isMultiConfig) {
      buildArgs.push('--config', 'Release')
    }
    execFileSync('cmake', buildArgs, {
      stdio: 'inherit',
      timeout: 600000,
      cwd: tmpDir
    })

    const candidatePaths = [
      path.join(buildDir, 'bin', BINARY_NAME),
      path.join(buildDir, 'bin', 'Release', BINARY_NAME),
      path.join(buildDir, BINARY_NAME),
      path.join(buildDir, 'tools', 'llama-mtmd-cli', BINARY_NAME),
      path.join(buildDir, 'tools', 'llama-mtmd-cli', 'Release', BINARY_NAME)
    ]
    const builtBinary = candidatePaths.find((p) => fs.existsSync(p))
    if (!builtBinary) {
      throw new Error(`llama-mtmd-cli not found after build. Checked: ${candidatePaths.join(', ')}`)
    }

    fs.mkdirSync(cacheDir, { recursive: true })
    fs.copyFileSync(builtBinary, binaryPath)
    fs.chmodSync(binaryPath, 0o755)

    const stat = fs.statSync(binaryPath)
    const provenance = {
      sourceKey,
      repo: sourceConfig.repo,
      ref: sourceConfig.ref,
      commitSha: localSha,
      builtAt: new Date().toISOString(),
      platform: os.platform(),
      arch: os.arch(),
      backend,
      cmakeFlags: mergedFlags,
      binarySizeMb: Math.round((stat.size / (1024 * 1024)) * 100) / 100
    }
    fs.writeFileSync(provenancePath, JSON.stringify(provenance, null, 2))

    log(`installed: ${binaryPath} (${provenance.binarySizeMb} MB)`)
    return { binaryPath, commitSha: localSha, ref: sourceConfig.ref, label: `${sourceConfig.label}@${sourceConfig.ref}`, provenance }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

function main () {
  const args = parseArgs(process.argv.slice(2))

  const enabledSources = (args.sources || 'fabric,upstream')
    .split(',').map((s) => s.trim()).filter(Boolean)

  const buildsDir = path.resolve(args['builds-dir'] || DEFAULT_BUILDS_DIR)
  const forceRebuild = Boolean(args['force-rebuild'])
  const backend = (args.backend || 'cpu').toString()
  if (backend !== 'cpu' && backend !== 'gpu') {
    throw new Error(`--backend must be 'cpu' or 'gpu', got '${backend}'`)
  }

  if (args['fabric-ref']) CLI_SOURCES.fabric.ref = args['fabric-ref']
  if (args['upstream-ref']) CLI_SOURCES.upstream.ref = args['upstream-ref']

  validatePrereqs()
  fs.mkdirSync(buildsDir, { recursive: true })

  const resolved = {}
  for (const key of enabledSources) {
    const cfg = CLI_SOURCES[key]
    if (!cfg) {
      logErr(`unknown source '${key}', skipping (known: ${Object.keys(CLI_SOURCES).join(', ')})`)
      continue
    }
    try {
      resolved[key] = buildOne(key, cfg, buildsDir, forceRebuild, backend)
    } catch (e) {
      logErr(`failed to build ${key}: ${e.message}`)
      process.exitCode = 1
    }
  }

  fs.writeFileSync(RESOLVED_PATH, JSON.stringify(resolved, null, 2))
  log(`wrote ${RESOLVED_PATH}`)
  log(`resolved sources: ${Object.keys(resolved).join(', ')}`)
}

main()
