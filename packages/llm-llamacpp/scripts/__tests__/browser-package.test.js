'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
const { build } = require('esbuild')

const exec = promisify(execFile)
const packageRoot = path.resolve(__dirname, '../..')

test('browser prebuild validator requires both matching engine pairs', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'llm-llamacpp-web-prebuild-'))
  t.after(() => rm(temp, { force: true, recursive: true }))
  const { validateEngineFiles, validatePackFiles } = await import('../validate-web-prebuild.mjs')

  for (const variant of ['llm-llamacpp', 'llm-llamacpp-64']) {
    await writeFile(
      path.join(temp, `${variant}.mjs`),
      `new URL("${variant}.wasm", import.meta.url)`
    )
    await writeFile(path.join(temp, `${variant}.wasm`), variant)
  }
  assert.doesNotThrow(() => validateEngineFiles(temp))

  await rm(path.join(temp, 'llm-llamacpp-64.wasm'))
  assert.throws(() => validateEngineFiles(temp), /Missing browser engine binary/)
  await writeFile(path.join(temp, 'llm-llamacpp-64.wasm'), 'llm-llamacpp-64')
  await writeFile(
    path.join(temp, 'llm-llamacpp-64.mjs'),
    'const expected = "llm-llamacpp-64.wasm"; new URL("llm-llamacpp.wasm", import.meta.url)'
  )
  assert.throws(() => validateEngineFiles(temp), /does not resolve its matching/)

  const files = ['llm-llamacpp.mjs', 'llm-llamacpp.wasm', 'llm-llamacpp-64.mjs'].map((name) => ({
    path: `prebuilds/web/${name}`
  }))
  assert.throws(
    () => validatePackFiles(JSON.stringify([{ files }])),
    /Packed package is missing prebuilds\/web\/llm-llamacpp-64\.wasm/
  )
})

test('packed package root bundles for a browser without native Bare bindings', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'llm-llamacpp-browser-package-'))
  t.after(() => rm(temp, { force: true, recursive: true }))
  const packDir = path.join(temp, 'pack')
  const extractDir = path.join(temp, 'extract')
  await mkdir(packDir)
  await mkdir(extractDir)

  const packed = await exec('npm', ['pack', '--json', '--pack-destination', packDir], {
    cwd: packageRoot
  })
  const [{ filename }] = JSON.parse(packed.stdout)
  await exec('tar', ['-xzf', path.join(packDir, filename), '-C', extractDir])

  const result = await build({
    absWorkingDir: packageRoot,
    bundle: true,
    entryPoints: [path.join(extractDir, 'package', 'index.js')],
    external: ['./prebuilds/web/*'],
    format: 'esm',
    logLevel: 'silent',
    nodePaths: [path.join(packageRoot, 'node_modules')],
    platform: 'browser',
    write: false
  })
  const bundle = result.outputFiles.map((file) => file.text).join('\n')
  assert.doesNotMatch(bundle, /require\.addon/)
  assert.doesNotMatch(bundle, /bare-os/)

  const bundlePath = path.join(temp, 'bundle.mjs')
  await writeFile(bundlePath, bundle)
  await assert.doesNotReject(() => import(pathToFileURL(bundlePath)))
})
