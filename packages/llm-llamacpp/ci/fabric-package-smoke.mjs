// Exercise the real PR artifacts through npm, outside the checkout. The desktop
// CI contract restores this consumer and its Fabric provider before this runs.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  SLICE_DEFINITIONS,
  FABRIC_BACKEND_DEFINITIONS,
  assertFabricBackendPackages,
  buildOptionalDependencies,
  stageSlice
} from '../../../scripts/ci/slice-platform-packages.mjs'
import { checkPackageSizes } from '../../../.github/actions/npm-publish-platform-packages/npm-publish-platform-packages.mjs'

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const modelName = 'Llama-3.2-1B-Instruct-Q4_0.gguf'

// Stage only the current host with the same mover/manifest/index generators as
// publishing. Never fabricate other hosts or relax the release completeness gate.
export function stagePackages({ fabricDir, consumerDir, root }) {
  const staged = path.join(root, 'packages')
  const metaDir = path.join(staged, 'fabric')
  fs.mkdirSync(metaDir, { recursive: true })
  const fabric = read(path.join(fabricDir, 'package.json'))
  const consumer = read(path.join(consumerDir, 'package.json'))
  assertFabricBackendPackages(path.join(fabricDir, 'prebuilds'))
  assert.ok(
    fs.existsSync(path.join(fabricDir, 'prebuilds/linux-x64/qvac__fabric-linux-x64.bare')),
    'missing PR Fabric runtime'
  )
  assert.ok(
    fs.existsSync(
      path.join(fabricDir, 'prebuilds/linux-x64/qvac__fabric-linux-x64/libqvac-ggml-hip.so')
    ),
    'missing HIP in base'
  )
  assert.ok(
    fs.existsSync(path.join(consumerDir, 'prebuilds/linux-x64/qvac__llm-llamacpp.bare')),
    'missing PR consumer addon'
  )
  for (const file of ['binding.js', 'addon-unavailable.js', 'LICENSE', 'NOTICE', 'README.md']) {
    fs.copyFileSync(path.join(fabricDir, file), path.join(metaDir, file))
  }
  for (const dir of ['linux-x64', 'include', 'share']) {
    fs.cpSync(path.join(fabricDir, 'prebuilds', dir), path.join(metaDir, 'prebuilds', dir), {
      recursive: true
    })
  }
  const linux = SLICE_DEFINITIONS.find((d) => d.suffix === 'linux-x64')
  const context = {
    metaManifest: fabric,
    workdir: metaDir,
    outDir: staged,
    prebuildsDir: path.join(metaDir, 'prebuilds')
  }
  const dirs = [...FABRIC_BACKEND_DEFINITIONS, linux].map((d) => stageSlice(d, context))
  fabric.optionalDependencies = buildOptionalDependencies(fabric, [linux])
  write(path.join(metaDir, 'package.json'), fabric)
  const consumerStage = path.join(staged, 'consumer')
  fs.mkdirSync(consumerStage)
  for (const file of consumer.files.filter((file) => file !== 'prebuilds')) {
    fs.cpSync(path.join(consumerDir, file), path.join(consumerStage, file), { recursive: true })
  }
  fs.cpSync(
    path.join(consumerDir, 'prebuilds/linux-x64'),
    path.join(consumerStage, 'prebuilds/linux-x64'),
    { recursive: true }
  )
  fs.copyFileSync(path.join(consumerDir, 'README.md'), path.join(consumerStage, 'README.md'))
  // Pin the application to this PR's provider even if the public consumer range
  // also accepts another release. These manifests exist only in the temp registry.
  consumer.dependencies['@qvac/fabric'] = fabric.version
  write(path.join(consumerStage, 'package.json'), consumer)
  return { dirs: [metaDir, ...dirs, consumerStage], fabric, consumer }
}

export function run(command, args, { cwd, env, log, timeout = 15 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const output = fs.openSync(log, 'w')
    const errors = fs.openSync(log + '.stderr', 'w')
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', output, errors] })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      fs.closeSync(output)
      fs.closeSync(errors)
      if (code === 0) resolve()
      else reject(new Error(`${command} failed (${signal || code}); see ${log} and ${log}.stderr`))
    })
  })
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function ready(registry, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Verdaccio exited before becoming ready')
    try {
      const response = await fetch(registry + '/-/ping', { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Verdaccio did not become ready')
}

export function childEnvironment(source) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !/^(AWS_|ACTIONS_|GITHUB_TOKEN$|GH_TOKEN$|NODE_AUTH_TOKEN$|NPM_TOKEN$|NPM_AUTH_TOKEN$)/i.test(
          key
        )
    )
  )
}

export async function smoke({ consumerDir, backend, model, results }) {
  assert.equal(process.platform + '-' + process.arch, 'linux-x64')
  assert.ok(['cpu', 'cuda'].includes(backend), 'backend must be cpu or cuda')
  // A failed rerun must not upload a previous run's successful summary.
  fs.rmSync(results, { recursive: true, force: true })
  fs.mkdirSync(results, { recursive: true })
  assert.ok(fs.existsSync(model), 'model is missing; fetch the test:backend model manifest first')
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'fabric-registry-'))
  let registryProcess
  let registryLog
  // An independent npm config/cache prevents workspace links and registry auth
  // from influencing the test. The local token stays in memory, never in reports.
  const env = {
    ...childEnvironment(process.env),
    NODE_AUTH_TOKEN: '',
    NPM_CONFIG_CACHE: path.join(root, 'cache'),
    NPM_CONFIG_USERCONFIG: path.join(root, 'npmrc'),
    OMP_NUM_THREADS: '4'
  }
  for (const key of ['NODE_PATH', 'QVAC_FABRIC_BACKENDS_DIR', 'GGML_BACKEND_PATH']) delete env[key]
  fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, '')
  const command = (cmd, args, name, cwd = root, extra = {}) =>
    run(cmd, args, { cwd, env: { ...env, ...extra }, log: path.join(results, name + '.log') })
  try {
    const { dirs, fabric, consumer } = stagePackages({
      fabricDir: path.resolve(consumerDir, '../fabric'),
      consumerDir,
      root
    })
    const tarballs = path.join(root, 'tarballs')
    fs.mkdirSync(tarballs)
    const records = []
    for (const [i, dir] of dirs.entries()) {
      await command(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs],
        'pack-' + i,
        dir
      )
      const info = read(path.join(results, 'pack-' + i + '.log'))[0]
      records.push({ dir, ...info })
    }
    checkPackageSizes(records, (record) => record)
    write(
      path.join(results, 'package-sizes.json'),
      records.map(({ id, size, unpackedSize, integrity }) => ({
        id,
        size,
        unpackedSize,
        integrity
      }))
    )
    // Installed by the workspace's frozen lockfile, never fetched at runtime.
    const verdaccio = path.join(consumerDir, 'node_modules/verdaccio/bin/verdaccio')
    const port = await freePort()
    const registry = 'http://127.0.0.1:' + port
    // Fabric and the consumer have NO uplink: a missing local package must fail.
    const config = {
      storage: path.join(root, 'storage'),
      auth: { htpasswd: { file: path.join(root, 'htpasswd'), max_users: 1 } },
      uplinks: { npmjs: { url: 'https://registry.npmjs.org/' } },
      packages: {
        '@qvac/fabric*': { access: '$all', publish: '$authenticated' },
        '@qvac/llm-llamacpp': { access: '$all', publish: '$authenticated' },
        '@*/*': { access: '$all', proxy: 'npmjs' },
        '**': { access: '$all', proxy: 'npmjs' }
      },
      max_body_size: '500mb',
      log: { type: 'stdout', format: 'json', level: 'warn' }
    }
    write(path.join(root, 'verdaccio.yaml'), config)
    registryLog = fs.openSync(path.join(results, 'registry.log'), 'w')
    registryProcess = spawn(
      process.execPath,
      [verdaccio, '--config', path.join(root, 'verdaccio.yaml'), '--listen', '127.0.0.1:' + port],
      { env, stdio: ['ignore', registryLog, registryLog] }
    )
    registryProcess.on('error', () => {}) // ready() surfaces startup failures with the registry log.
    await ready(registry, registryProcess)
    assert.equal(
      (await fetch(registry + '/@qvac%2ffabric-linux-x64-cuda')).status,
      404,
      'registry must not proxy unpublished Fabric packages'
    )
    const response = await fetch(registry + '/-/user/org.couchdb.user:smoke', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'smoke',
        password: crypto.randomBytes(32).toString('hex'),
        email: 'smoke@example.invalid',
        type: 'user'
      })
    })
    const registration = await response.json()
    assert.ok(response.ok && registration.token, 'could not register local publisher')
    fs.writeFileSync(
      env.NPM_CONFIG_USERCONFIG,
      `registry=${registry}/\n//127.0.0.1:${port}/:_authToken=\${NODE_AUTH_TOKEN}\n`
    )
    for (const [i, record] of records.entries()) {
      await command(
        'npm',
        [
          'publish',
          path.join(tarballs, record.filename),
          '--ignore-scripts',
          '--access',
          'public',
          '--registry',
          registry
        ],
        'publish-' + i,
        root,
        { NODE_AUTH_TOKEN: registration.token }
      )
    }
    // Anonymous consumer, a second empty cache, and no checkout-relative deps.
    fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, `registry=${registry}/\n`)
    env.NPM_CONFIG_CACHE = path.join(root, 'consumer-cache')
    env.NPM_CONFIG_REGISTRY = registry
    const app = path.join(root, 'app')
    fs.mkdirSync(app)
    write(path.join(app, 'package.json'), {
      name: 'fabric-registry-smoke',
      version: '1.0.0',
      private: true,
      dependencies: {
        '@qvac/llm-llamacpp': consumer.version,
        'bare-fs': '4.5.1',
        'bare-process': '4.2.2'
      }
    })
    fs.copyFileSync(
      path.join(consumerDir, 'test/integration/fabric-package-inference.js'),
      path.join(app, 'inference.js')
    )
    await command(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
      'install-app',
      app
    )
    await command('npm', ['ls', '--all', '--json'], 'dependency-tree', app)
    const lock = read(path.join(app, 'package-lock.json'))
    for (const name of ['fabric', 'fabric-linux-x64', 'fabric-linux-x64-cuda', 'llm-llamacpp']) {
      assert.ok(
        lock.packages['node_modules/@qvac/' + name].resolved.startsWith(registry + '/'),
        'QVAC package did not come from the local registry: ' + name
      )
    }
    fs.copyFileSync(path.join(app, 'package-lock.json'), path.join(results, 'package-lock.json'))
    const installed = (name) => path.join(app, 'node_modules/@qvac', name)
    for (const name of ['fabric', 'fabric-linux-x64', 'fabric-linux-x64-cuda']) {
      assert.equal(read(path.join(installed(name), 'package.json')).version, fabric.version)
    }
    assert.ok(!fs.existsSync(installed('fabric-linux-x64-hip')), 'unexpected HIP package')
    assert.ok(
      fs.existsSync(
        path.join(
          installed('fabric-linux-x64'),
          'prebuilds/linux-x64/qvac__fabric-linux-x64/libqvac-ggml-hip.so'
        )
      ),
      'HIP missing from installed base'
    )
    await command('bare', ['inference.js', model, backend], 'inference', app)
    fs.copyFileSync(path.join(app, 'result.json'), path.join(results, 'inference.json'))
    write(path.join(results, 'summary.json'), {
      passed: true,
      backend,
      fabricVersion: fabric.version,
      consumerVersion: consumer.version
    })
    console.log(`Fabric registry smoke passed (${backend}); reports: ${results}`)
  } finally {
    if (registryProcess && registryProcess.exitCode === null) {
      const exited = new Promise((resolve) => registryProcess.once('close', resolve))
      registryProcess.kill('SIGTERM')
      const timer = setTimeout(() => registryProcess.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    }
    if (registryLog !== undefined) fs.closeSync(registryLog)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  assert.equal(args.length, 2, 'usage: fabric-package-smoke.mjs --backend cpu|cuda')
  assert.equal(args[0], '--backend')
  const consumerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  await smoke({
    consumerDir,
    backend: args[1],
    model: path.join(consumerDir, 'test/model', modelName),
    results: path.join(consumerDir, 'test/results/e2e', 'fabric-packaging-' + args[1])
  })
}
