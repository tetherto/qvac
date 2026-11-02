import test from 'brittle'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandLogger } from '@/commands/command-logger'
import { linkAddons, warnOverwritten } from '@/expo/plugins/link-addons'
import type { Logger } from '@/logging/types'

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

function installBareKit(projectRoot: string) {
  const bareKitDir = join(projectRoot, 'node_modules', 'react-native-bare-kit')
  writeFile(
    join(bareKitDir, 'package.json'),
    JSON.stringify({ name: 'react-native-bare-kit', version: '0.16.0' })
  )
  return bareKitDir
}

test('linkAddons: links nothing when react-native-bare-kit is not installed', async (t) => {
  const projectRoot = createProject(t)
  const entryPath = join(projectRoot, 'qvac', 'worker.entry.mjs')
  writeFile(entryPath, '')

  t.alike(await linkAddons({ projectRoot, entryPath, hosts: ['android-arm64'], logger }), [])
})

test('linkAddons: replaces what react-native-bare-kit had for the platform', async (t) => {
  const projectRoot = createProject(t)
  const bareKitDir = installBareKit(projectRoot)
  const stale = join(bareKitDir, 'android', 'src', 'main', 'addons', 'arm64-v8a', 'libold.so')
  writeFile(stale, '')
  const entryPath = join(projectRoot, 'qvac', 'worker.entry.mjs')
  writeFile(entryPath, '')

  const linked = await linkAddons({ projectRoot, entryPath, hosts: ['android-arm64'], logger })

  t.alike(linked, [])
  t.absent(existsSync(stale), 'addons linked by an earlier prebuild are removed')
})

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
