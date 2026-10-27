import type { LaunchOptions, LoadedConfig, CoreConfig, ParsedCommand } from '../lib/types.js'
// Runtime-agnostic: bin/qvac.mjs runs it on Node, bin/qvac-bare.mjs on Bare; each starts the app.
import fs from '#fs'
import path from '#path'
import os from '#os'
import process from '#process'
import { AbortController } from '#abort-controller'
import { fileURLToPath } from '#url'
import { loadConfig } from '../lib/runtime/config.js'
import { runtimeJson } from '../lib/runtime/config-json.js'
import { find, parseArgs } from './index.js'
import { packageVersion, versionText } from './version.js'
import type { ChildProcess } from 'node:child_process'

const root = import.meta.url.startsWith('file:')
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  : path.dirname(fileURLToPath(import.meta.asset('../../package.json')))
const version = packageVersion(root)

// launcher: how the app calls back; runApp starts it
export async function launch(
  args: string[],
  {
    launcher,
    runApp,
    node = process.execPath
  }: {
    launcher: LaunchOptions['launcher'] | null
    runApp(options: LaunchOptions, env: NodeJS.ProcessEnv): Promise<void> | void
    node?: string
  }
) {
  // The app asks for this when Core restarts, so a plugin added to qvac.config since launch loads.
  if (args[0] === '__runtime-config') {
    await rewriteRuntimeConfig(args[1]!, args[2])
    process.exit(0)
  }

  let parsed: ParsedCommand
  try {
    parsed = parseArgs(args, { env: process.env })
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error))
  }

  const app = async (options: LaunchOptions) => {
    const env = await prepare(options)
    options.launcher = launcher ?? undefined
    await runApp(options, env)
  }

  const { command, action, words, options, where } = parsed
  if (command === 'version') {
    console.log(versionText(root))
    return
  }

  // a Core command runs in the app, which finds its runner in the same tree
  if (where === 'core') {
    await app({ ...options, command, action, words, columns: process.stdout.columns })
    return
  }

  const kit = {
    root,
    version,
    node,
    app,
    usage,
    loadConfig: config,
    dataDir,
    supervise,
    fs,
    process,
    AbortController
  }
  const route = find(command, action)
  if (route.where !== 'launcher' && route.where !== 'app') {
    throw new Error(`Invalid launcher command: ${command}`)
  }
  await route.run(parsed, kit)
}

async function rewriteRuntimeConfig(file: string, configFile?: string) {
  try {
    const loaded = await loadConfig({ file: configFile || undefined })
    loaded.config.core.dataDir = JSON.parse(fs.readFileSync(file, 'utf8')).config.core.dataDir
    fs.writeFileSync(file, runtimeJson(loaded), { mode: 0o600 })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

// fills options in place and returns the env the app runs with
async function prepare(options: LaunchOptions) {
  options.version = version

  return applyConfig(options, { loaded: await config(options.configFile) })
}

// a config that is missing or does not load is the user's to fix, so it gets a line, not a stack
async function config(file?: string) {
  try {
    return await loadConfig({ file })
  } catch (error) {
    console.error(`qvac: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

function usage(message: string): never {
  console.error(`qvac: ${message}`)
  process.exit(2)
}

function dataDir(options: LaunchOptions, core: CoreConfig) {
  return path.resolve(options.dataDir || core.dataDir || path.join(os.homedir(), '.qvac', 'cli'))
}

function applyConfig(options: LaunchOptions, { loaded }: { loaded: LoadedConfig }) {
  const { core, tui } = loaded.config
  if (options.temp) {
    options.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-'))
  }

  options.dataDir = dataDir(options, core)
  options.deviceName = options.deviceName || core.deviceName
  options.accountName = options.accountName || core.accountName
  // a model named by flag or file is the agent's; the auto pick only seeds a new agent
  options.modelChosen = !!options.model || loaded.sources['core.model'] === 'config'
  // the test-only fake model must not be replaced by a configured or default model
  options.model = options.fakeModels ? undefined : options.model || core.model
  options.noDefaultModels = options.noDefaultModels ?? core.autoDownloadModels === false
  options.startPage = options.startPage || tui.startPage || 'chat'
  options.theme = tui.theme || 'terminal'
  core.dataDir = options.dataDir
  fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })
  options.runtimeConfig = path.join(options.dataDir, 'cli-runtime-config.json')
  fs.writeFileSync(options.runtimeConfig, runtimeJson(loaded), { mode: 0o600 })
  // the SDK's own keys sit beside QV.AC's three in qvac.config; the harness passes them to the SDK
  const { core: _core, harness: _harness, tui: _tui, ...sdk } = loaded.config
  const sdkOptions = path.join(options.dataDir, 'cli-sdk-options.json')
  fs.writeFileSync(sdkOptions, JSON.stringify(sdk), { mode: 0o600 })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QVAC_CLI_CONFIG: options.runtimeConfig,
    QVAC_SDK_OPTIONS: sdkOptions,
    QVAC_HARNESS_HOST_MODULE: path.join(root, 'dist/lib/runtime/harness-extension.js')
  }
  if (core.modelsDir) {
    env['QVAC_MODEL_CACHE_PATH'] = core.modelsDir
  }

  return env
}

export function supervise(child: ChildProcess) {
  let terminating = false
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      if (!terminating) {
        terminating = true
        child.kill(signal)
      }
    })
  }

  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  child.on('error', (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
