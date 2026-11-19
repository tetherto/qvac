'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const { createHash } = require('node:crypto')

const runtimeSymbol =
  /^(?:__cxa_|__gxx_personality|__dynamic_cast$|_ZT[ISVT](?:St|NSt|N10__cxxabiv1)|_ZTC(?:St|NSt|N10__cxxabiv1)|_Zn[wa]|_Zd[la]|_ZN[KVR]*(?:St|S[abiosd]|10__cxxabiv1)|_ZSt|_ZGVNSt)/
const systemSymbol = /^(?:__cxa_(?:atexit|finalize|thread_atexit_impl)$|_Unwind_)/
// Itanium thunks encode this/vtable offsets before the underlying function.
// Match that function's namespace, not std types in an unrelated XRT signature.
const runtimeThunk =
  /^_ZT(?:h[n]?\d+_|v[n]?\d+_[n]?\d+_|c(?:h[n]?\d+_|v[n]?\d+_[n]?\d+_){2})(?:N[KVR]*(?:St|S[abiosd]|10__cxxabiv1)|St)/
const isRuntime = (symbol) =>
  (runtimeSymbol.test(symbol) || runtimeThunk.test(symbol)) && !systemSymbol.test(symbol)

function initializedBackend(line) {
  const match = /calling init: (.+?)(?: \[\d+\])?\s*$/.exec(line)
  if (!match) return null
  return /(?:^|\/)(?:lib)?(?:qvac-)?(?:diffusion-|speech-)?ggml-[^/]+\.so(?:\.[0-9.]+)?$/.test(
    match[1]
  )
    ? match[1]
    : null
}

function workerResult(stdout) {
  for (const line of stdout.split('\n')) {
    try {
      const result = JSON.parse(line)
      if (result.kind === 'ggml-coexistence') return result
    } catch {
      // Native diagnostics can share stdout with the worker result.
    }
  }
  return null
}

function parseBindings(trace) {
  const bindings = []
  for (const line of trace.split('\n')) {
    const match =
      /binding file (.+?) \[\d+\] to (.+?) \[\d+\]:.*symbol [`']([^']+)'(?: \[([^\]]+)\])?/.exec(
        line
      )
    if (match) {
      bindings.push({
        client: match[1],
        provider: match[2],
        symbol: match[3],
        version: match[4] || null
      })
    }
  }
  return bindings
}

function sameFile(left, right) {
  // Loader output can use a symlinked name. Compare canonical paths when present,
  // and retain a deterministic fallback for saved traces on another machine.
  const canonical = (file) => {
    try {
      return fs.realpathSync(file)
    } catch {
      return path.resolve(file)
    }
  }
  return canonical(left) === canonical(right)
}

function checkBindings(bindings, { qvacClients, qvacProviders, privateClients, gnuClients = [] }) {
  const failures = []
  for (const [kind, clients] of [
    ['qvac', qvacClients],
    ['private', privateClients],
    ['gnu', gnuClients]
  ]) {
    for (const client of clients) {
      const observed = bindings.filter((binding) => sameFile(binding.client, client))
      if (observed.length === 0) {
        failures.push(`${kind} client was not observed: ${client}`)
        continue
      }
      const runtime = observed.filter((binding) => isRuntime(binding.symbol))
      if (kind !== 'private' && runtime.length === 0) {
        failures.push(`No C++ runtime bindings observed for ${kind} client: ${client}`)
      }
      for (const binding of observed) {
        const runtime = isRuntime(binding.symbol)
        const fromQvac = qvacProviders.some((provider) => sameFile(binding.provider, provider))
        let bad = false
        if (kind === 'qvac' && runtime) bad = !fromQvac
        if (kind === 'gnu' && runtime) bad = path.basename(binding.provider) !== 'libstdc++.so.6'
        if (kind === 'private' && (runtime || /^(?:ggml|gguf)_/.test(binding.symbol))) {
          bad = fromQvac
        }
        if (bad) {
          failures.push(
            `${client}: ${binding.symbol} bound to ${binding.provider} (${binding.version || 'unversioned'})`
          )
        }
      }
    }
  }
  return failures
}

async function main(args) {
  const options = { bare: 'bare', providers: [], gnuClients: [], qvacClients: [] }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    const value = args[i + 1]
    if (!value) throw new Error('Missing value for ' + key)
    if (key === '--qvac-provider') options.providers.push(path.resolve(value))
    else if (key === '--gnu-client') options.gnuClients.push(path.resolve(value))
    else if (key === '--qvac-client') options.qvacClients.push(path.resolve(value))
    else if (
      ['--bare', '--fabric', '--diffusion', '--diffusion-backends', '--report-dir'].includes(key)
    ) {
      options[key.slice(2)] = value
    } else throw new Error('Unknown argument: ' + key)
  }
  for (const key of ['fabric', 'diffusion', 'diffusion-backends', 'report-dir']) {
    if (!options[key]) throw new Error('Required: --' + key)
    options[key] = path.resolve(options[key])
  }
  if (process.platform !== 'linux') throw new Error('Binding audit requires the Linux glibc loader')
  const providers = options.providers.length ? options.providers : [options.fabric]
  for (const file of [
    options.fabric,
    options.diffusion,
    options['diffusion-backends'],
    ...providers,
    ...options.gnuClients,
    ...options.qvacClients
  ]) {
    fs.accessSync(file)
  }
  fs.mkdirSync(options['report-dir'], { recursive: true })
  const results = []
  const loadedArtifacts = new Set()
  for (const order of ['fabric-first', 'diffusion-first']) {
    const env = { ...process.env, LD_DEBUG: 'bindings,versions', LD_BIND_NOW: '1' }
    // Capture trace in stderr even if the caller configured another destination.
    delete env.LD_DEBUG_OUTPUT
    const bindings = []
    const loadedBackends = new Set()
    const interested = [
      options.fabric,
      options.diffusion,
      ...options.gnuClients,
      ...options.qvacClients
    ]
    const clientCache = new Map()
    const trace = fs.openSync(path.join(options['report-dir'], order + '.bindings.log'), 'w')
    const stdout = fs.openSync(path.join(options['report-dir'], order + '.stdout.log'), 'w')
    const child = spawn(
      options.bare,
      [
        path.join(__dirname, 'coexistence-worker.js'),
        order,
        options.fabric,
        options.diffusion,
        options['diffusion-backends']
      ],
      {
        env,
        stdio: ['ignore', stdout, 'pipe']
      }
    )
    let spawnError
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 60000)
    const closed = new Promise((resolve) => {
      child.on('error', (error) => {
        spawnError = error
      })
      child.on('close', (status, signal) => resolve({ status, signal }))
    })
    // ROCm can generate enormous loader traces. Retain all non-binding
    // diagnostics, but only bindings for explicitly audited clients.
    for await (const line of readline.createInterface({ input: child.stderr })) {
      const backend = initializedBackend(line)
      if (backend) loadedBackends.add(backend)
      const [binding] = parseBindings(line)
      if (binding) {
        if (!clientCache.has(binding.client)) {
          clientCache.set(
            binding.client,
            interested.some((client) => sameFile(client, binding.client))
          )
        }
        if (!clientCache.get(binding.client)) continue
        bindings.push(binding)
      }
      fs.writeSync(trace, line + '\n')
    }
    const result = await closed
    clearTimeout(timer)
    fs.closeSync(trace)
    fs.closeSync(stdout)
    const reported = workerResult(
      fs.readFileSync(path.join(options['report-dir'], order + '.stdout.log'), 'utf8')
    )
    const failures = checkBindings(bindings, {
      qvacClients: [options.fabric, ...options.qvacClients],
      qvacProviders: providers,
      privateClients: [options.diffusion],
      gnuClients: options.gnuClients
    })
    if (spawnError || timedOut || result.status !== 0) {
      failures.unshift(
        `Worker failed: ${spawnError?.message || (timedOut ? 'timeout' : result.signal || result.status)}`
      )
    }
    if (!reported || reported.order !== order || typeof reported.hostExecutable !== 'string') {
      failures.push('Worker completion/host identity was not reported')
    } else {
      loadedArtifacts.add(reported.hostExecutable)
    }
    for (const backend of loadedBackends) loadedArtifacts.add(backend)
    results.push({
      order,
      ...result,
      hostExecutable: reported?.hostExecutable || null,
      loadedBackends: [...loadedBackends],
      bindings: bindings.length,
      failures
    })
  }
  const artifacts = [
    ...new Set([
      options.fabric,
      options.diffusion,
      ...providers,
      ...options.gnuClients,
      ...options.qvacClients,
      ...loadedArtifacts
    ])
  ].map((file) => ({
    file,
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  }))
  fs.writeFileSync(
    path.join(options['report-dir'], 'summary.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        hostCommand: options.bare,
        fabricBackendsDir: process.env.QVAC_FABRIC_BACKENDS_DIR || null,
        diffusionBackendsDir: options['diffusion-backends'],
        artifacts,
        orders: results
      },
      null,
      2
    ) + '\n'
  )
  console.log(JSON.stringify(results, null, 2))
  return results.some((result) => result.failures.length) ? 1 : 0
}

module.exports = { parseBindings, checkBindings, initializedBackend, workerResult }
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 2
    })
}
