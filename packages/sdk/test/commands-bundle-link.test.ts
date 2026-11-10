import test from 'brittle'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCommandLogger } from '@/commands/command-logger'
import {
  assertReactNativeBareKitSupported,
  stageAddons,
  type StageAddonsOptions,
  warnOverwritten
} from '@/commands/bundle/link'
import { discardScratch, replaceAll, scratchFolderFor } from '@/commands/bundle/scratch'
import type { Logger } from '@/logging/types'
import { linkDependency } from './fixtures/link-dependency'

const SDK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const logger = createCommandLogger({ quiet: true })

function createProject(t: { teardown: (fn: () => void) => void }) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'qvac-link-addons-')))
  t.teardown(() => rmSync(projectRoot, { recursive: true, force: true }))
  return projectRoot
}

function writeFile(file: string, content: string) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

function installBareKit(projectRoot: string, version: string) {
  writeFile(
    join(projectRoot, 'node_modules', 'react-native-bare-kit', 'package.json'),
    JSON.stringify({ name: 'react-native-bare-kit', version })
  )
}

function writeSdk(projectRoot: string) {
  const sdkPath = join(projectRoot, 'node_modules', '@qvac', 'sdk')
  writeFile(
    join(sdkPath, 'package.json'),
    JSON.stringify({ name: '@qvac/sdk', peerDependencies: { 'react-native-bare-kit': '^0.17.1' } })
  )
  return sdkPath
}

async function linkAddons(options: StageAddonsOptions) {
  const { written, staged } = await stageAddons(options)
  try {
    await replaceAll(staged)
  } finally {
    for (const { next } of staged) await discardScratch(next)
  }
  return written
}

/** A project whose worker entry loads no native addon. */
function createWorkerProject(t: { teardown: (fn: () => void) => void }) {
  const projectRoot = createProject(t)
  linkDependency(projectRoot, 'bare-stow-runtime', SDK_DIR)
  const entryPath = join(projectRoot, 'qvac', 'worker.entry.mjs')
  writeFile(entryPath, 'export default function start() {}\n')
  return { projectRoot, entryPath }
}

test('assertReactNativeBareKitSupported: rejects a release older than the SDK requires', async (t) => {
  const projectRoot = createProject(t)
  installBareKit(projectRoot, '0.16.0')

  await t.exception(
    () => assertReactNativeBareKitSupported(projectRoot, writeSdk(projectRoot)),
    /needs react-native-bare-kit \^0\.17\.1; found 0\.16\.0/
  )
})

test('assertReactNativeBareKitSupported: accepts a release in range, or none installed', async (t) => {
  const supported = createProject(t)
  installBareKit(supported, '0.17.1')
  await t.execution(() => assertReactNativeBareKitSupported(supported, writeSdk(supported)))

  const missing = createProject(t)
  await t.execution(() => assertReactNativeBareKitSupported(missing, writeSdk(missing)))
})

test('stageAddons: writes the Android module and replaces what it had', async (t) => {
  const { projectRoot, entryPath } = createWorkerProject(t)
  const moduleDir = join(projectRoot, 'android', 'qvac-bare-kit')
  const stale = join(moduleDir, 'src', 'main', 'addons', 'arm64-v8a', 'libold.so')
  writeFile(stale, '')

  const linked = await linkAddons({
    projectRoot,
    entryPath,
    hosts: ['android-arm64'],
    imports: {},
    defer: [],
    logger
  })

  const gradle = join(moduleDir, 'build.gradle')
  t.ok(linked.includes(gradle))
  t.absent(existsSync(stale), 'files from an earlier link are removed')
  t.absent(existsSync(join(projectRoot, 'ios', 'QvacBareKit')), 'only the given hosts are linked')
  const manifest = readFileSync(gradle, 'utf8')
  t.ok(manifest.includes('io.tether.qvac.sdk.addons'))
  t.ok(manifest.includes('bare-kit-kotlin'))
})

test('replaceAll: a failed move puts back the folders already moved', async (t) => {
  const projectRoot = createProject(t)
  const worker = join(projectRoot, 'qvac', 'worker')
  const module = join(projectRoot, 'android', 'qvac-bare-kit')
  writeFile(join(worker, 'index.js'), 'working worker')
  writeFile(join(module, 'build.gradle'), 'working module')

  const nextWorker = await scratchFolderFor(worker)
  writeFile(join(nextWorker, 'index.js'), 'new worker')
  const nextModule = await scratchFolderFor(module)
  rmSync(nextModule, { recursive: true, force: true })

  await t.exception(
    replaceAll([
      { dir: worker, next: nextWorker },
      { dir: module, next: nextModule }
    ])
  )

  t.is(readFileSync(join(worker, 'index.js'), 'utf8'), 'working worker')
  t.is(readFileSync(join(module, 'build.gradle'), 'utf8'), 'working module')
  t.is(readFileSync(join(nextWorker, 'index.js'), 'utf8'), 'new worker')
})

test('stageAddons: a failed link leaves the app module as it was', async (t) => {
  const { projectRoot } = createWorkerProject(t)
  const moduleDir = join(projectRoot, 'android', 'qvac-bare-kit')
  const working = join(moduleDir, 'build.gradle')
  writeFile(working, 'working module')

  await t.exception(
    stageAddons({
      projectRoot,
      entryPath: join(projectRoot, 'missing-entry.mjs'),
      hosts: ['android-arm64'],
      imports: {},
      defer: [],
      logger
    })
  )

  t.is(readFileSync(working, 'utf8'), 'working module')
  t.alike(
    readdirSync(join(projectRoot, 'android')).filter((name) => name.startsWith('.')),
    []
  )
})

test(
  'stageAddons: writes the iOS Swift package',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const { projectRoot, entryPath } = createWorkerProject(t)

    const linked = await linkAddons({
      projectRoot,
      entryPath,
      hosts: ['ios-arm64', 'ios-arm64-simulator'],
      imports: {},
      defer: [],
      logger
    })

    const manifest = join(projectRoot, 'ios', 'QvacBareKit', 'Package.swift')
    t.ok(linked.includes(manifest))
    t.ok(readFileSync(manifest, 'utf8').includes('bare-kit-swift'))
  }
)

test('warnOverwritten: names the libraries several addons wrote to the same path', (t) => {
  const warnings: string[] = []
  const recorder = { warn: (message: string) => warnings.push(message) } as unknown as Logger
  const out = 'addons'
  const speech = join(out, 'arm64-v8a', 'libqvac-speech-ggml-vulkan.so')

  warnOverwritten([speech, join(out, 'arm64-v8a', 'libqvac__asr-ggml.so'), speech], out, recorder)

  t.is(warnings.length, 1)
  t.ok(warnings[0]!.includes(join('arm64-v8a', 'libqvac-speech-ggml-vulkan.so')))
  t.absent(warnings[0]!.includes('libqvac__asr-ggml.so'), 'files written once are not named')
})

test('warnOverwritten: stays quiet when every file is written once', (t) => {
  const warnings: string[] = []
  const recorder = { warn: (message: string) => warnings.push(message) } as unknown as Logger

  warnOverwritten([join('addons', 'a.so'), join('addons', 'b.so')], 'addons', recorder)

  t.alike(warnings, [])
})
