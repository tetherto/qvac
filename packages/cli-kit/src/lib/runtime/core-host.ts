import type { Client as CoreClient } from '@qvac/core/client'
import type { Capabilities } from '@qvac/core/client'
import type { LaunchOptions } from '../types.js'
import type { CoreHost } from '../types.js'
// Starts Core and its execution host as a sidecar; heavy modules load after the first frame.
import b4a from 'b4a'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import process from 'bare-process'
import { spawnSync } from 'bare-subprocess'
import { storeInUse } from './store-lock.js'
import { fileURLToPath } from 'bare-url'
import { applyAgentProfile, applyToolConfigs } from './agent-profile.js'
import { enableSkills, installSkills } from './skills.js'
import type { AssistantStorage } from '@qvac/harness/storage'
import type { MeshInvite } from '@qvac/core/invite'

// a name, not a literal: Bare links each literal import.meta.resolve() when it loads
const SIDECAR_ENTRY = '@qvac/core/sidecar-entry'

const DEFAULT_MODEL = 'Qwen3.5-9B-Q4_K_M'

const skillsRoot = (asset: string | import('bare-url')) =>
  path.dirname(path.dirname(fileURLToPath(asset)))

function resolvePaths(entries: LaunchOptions['entries']) {
  if (entries) {
    return {
      skillsDir: skillsRoot(entries.skill),
      // a standalone build ships the CLI's own skills only once its launcher names one
      cliSkillsDir: entries.cliSkill ? skillsRoot(entries.cliSkill) : null,
      harnessEntry: fileURLToPath(entries.harness),
      sidecarEntry: fileURLToPath(entries.sidecar)
    }
  }

  const sidecarEntry = fileURLToPath(import.meta.resolve(SIDECAR_ENTRY))

  return {
    // asset, not resolve: Bare loads anything import.meta.resolve names as a module
    skillsDir: skillsRoot(import.meta.asset('@qvac/skills/skills/weather/SKILL.md')),
    cliSkillsDir: skillsRoot(import.meta.asset('../../../skills/qvac-plugins/SKILL.md')),
    harnessEntry: new URL(import.meta.resolve('@qvac/harness/worker/stow-entry.mjs')).pathname,
    sidecarEntry
  }
}

function checkInvite(
  { join, deviceJoin }: LaunchOptions,
  decodeMeshInvite: (invite: string) => MeshInvite | null
) {
  if (join && deviceJoin) {
    throw new Error('Pass --join or --device-join, not both.')
  }

  const raw = join || deviceJoin
  if (!raw) {
    return null
  }

  const invite = decodeMeshInvite(raw)
  if (!invite) {
    throw new Error('Not a QV.AC invite: expected qvac://device/… or qvac://workspace/…')
  }

  if (join && !invite.memberInvite) {
    throw new Error('That is a device invite: use --device-join.')
  }

  if (deviceJoin && invite.memberInvite) {
    throw new Error('That is a member invite: use --join.')
  }

  return raw
}

async function joined(engine: Capabilities) {
  for await (const { state, error } of engine.meshStatusWatch({})) {
    if (state === 'joined') return
    if (state === 'error' || state === 'kicked') {
      throw new Error(error || `The join ended: ${state}`)
    }
  }
}

async function startSidecar({
  Client,
  sidecarRunner,
  entry,
  config,
  logger
}: {
  Client: typeof CoreClient
  sidecarRunner: typeof import('bare-supervisor/runner/sidecar').default
  entry: string
  config: unknown
  logger: unknown
}) {
  let exited: Promise<number> | null = null
  const engine = new Client(async () => {
    const { ipc, exit } = sidecarRunner(entry, [JSON.stringify(config)], logger)
    exited = exit
    // resolves rather than rejects, or the child's clean exit at teardown goes unhandled
    const died = exit.then((code) => `Core exited (${code}) before it was ready`)
    const failure = await Promise.race([ipc.ready.then(() => null), died])
    if (failure) {
      throw new Error(failure)
    }

    return ipc
  })
  await engine.ready()

  return { engine, exited: exited! }
}

const hex = (id: Iterable<number> | null | undefined) => (id ? b4a.toHex(b4a.from(id)) : '')

async function grantFolders(host: CoreHost, options: LaunchOptions) {
  const folders = options.config?.core?.folders
  if (!folders) {
    return
  }

  const agent = await hostedAgent(host, options.config?.core.agentId)
  await host.engine.configSet({
    key: `fs.${agent.id}.roots`,
    value: folders.map((f) => ({ kind: 'local', path: f.path }))
  })
  await host.engine.configSet({
    key: `fs.${agent.id}.writable`,
    value: folders.filter((f) => f.write).map((f) => f.path)
  })
}

async function hostedAgent(host: CoreHost, agentId?: string) {
  const { engine, deviceId } = host
  const { meshId } = await engine.account({})
  const { agents } = await engine.listAgents({ meshId: meshId! })
  let agent = agentId
    ? (agents ?? []).find((a) => a.id === agentId)
    : (agents ?? []).find((a) => a.isDefault && hex(a.providerDeviceId) === hex(deviceId))
  if (agentId && !agent) {
    throw new Error('Configured core.agentId was not found in this account')
  }

  agent ??= await engine.createAgent({
    meshId: meshId!,
    config: {
      name: 'QV.AC',
      bio: 'You are a helpful local coding assistant. Use tools to verify your work.',
      providerDeviceId: b4a.from(deviceId!),
      modelName: host.modelName || 'Qwen3.5-2B-Q4_K_M',
      isDefault: true
    }
  })
  if (hex(agent.providerDeviceId) !== hex(deviceId)) {
    throw new Error('Configured folder grants must name an agent hosted on this device')
  }

  return agent
}

async function loadCoreModules() {
  const [
    { Client },
    { decodeMeshInvite },
    { Logger, toLoggerOptions },
    { configureSdkStorage },
    { MODEL_CACHE_PATH_ENV, releaseChannel, resolveStorage },
    { default: sidecarRunner }
  ] = await Promise.all([
    import('@qvac/core/client'),
    import('@qvac/core/invite'),
    import('@qvac/core/log'),
    import('@qvac/harness/sdk-storage'),
    import('@qvac/harness/storage'),
    import('bare-supervisor/runner/sidecar')
  ])
  return {
    Client,
    decodeMeshInvite,
    Logger,
    toLoggerOptions,
    configureSdkStorage,
    MODEL_CACHE_PATH_ENV,
    releaseChannel,
    resolveStorage,
    sidecarRunner
  }
}

export function bootstrapNodes(list: string) {
  return list.split(',').map((node: string) => {
    const at = node.lastIndexOf(':')
    return { host: node.slice(0, at).trim(), port: Number(node.slice(at + 1)) }
  })
}

function sidecarConfig(
  options: LaunchOptions,
  {
    environment,
    storage,
    logFlags,
    paths,
    device
  }: {
    environment: string
    storage: AssistantStorage
    logFlags: unknown
    paths: ReturnType<typeof resolvePaths>
    device: unknown
  }
) {
  const env = process.env
  return {
    environment,
    autoDownloadModels: options.noDefaultModels ? false : undefined,
    eager: !options.noDefaultModels,
    llm: options.config?.harness?.llm,
    storage: { root: storage.root, models: storage.sdk.models },
    logFlags,
    skillsDir: paths.skillsDir,
    harnessEntry: paths.harnessEntry,
    fakeModels: !!options.fakeModels || env['QVAC_FAKE_MODELS'] === '1',
    // the sidecar takes them as JSON; a private DHT lets several devices meet on one machine
    bootstrapNodes: options.bootstrap
      ? JSON.stringify(bootstrapNodes(options.bootstrap))
      : undefined,
    // argv is readable by anything that lists processes, so only the image keys cross
    imageEnv: Object.fromEntries(
      Object.entries(env).filter(([key]) => key.startsWith('QVAC_IMAGE_'))
    ),
    device
  }
}

async function connectHost(
  host: CoreHost,
  { invite, options }: { invite: string | null | undefined; options: LaunchOptions }
) {
  const { engine } = host
  host.deviceId = (await engine.deviceInfo({})).id
  if (invite) {
    await engine.joinMesh({ invite })
    await joined(engine)
  }

  // a mesh that cannot mint an invite yet must not fail the boot
  host.meshInvite = (await engine.meshInvite({}).catch(() => null))?.invite ?? null
  await configureDevice(host, options)
  await suggestPrompts(engine, options.config?.tui?.suggestions !== false)
}

// Core suggests the next message only for a host that asks; the composer offers it to tab into.
const suggestPrompts = (engine: Capabilities, on: boolean) =>
  engine.configSet({ key: 'assistant.suggestPrompts', value: on ? 'on' : 'off' })

// This device's agent as the flags and qvac.config say; again after a pairing, whose account is new.
export async function configureDevice(host: CoreHost, options: LaunchOptions) {
  await grantFolders(host, options)
  await applyProfile(host, options)
}

async function applyProfile(host: CoreHost, options: LaunchOptions) {
  const profile = options.config?.core?.agent
  const model = options.modelChosen ? host.modelName : null
  if (!profile && !model) {
    return
  }

  const { meshId } = await host.engine.account({})
  const agent = await hostedAgent(host, options.config?.core.agentId)
  if (model && agent.modelName !== model) {
    await host.engine.updateAgent({
      agentId: agent.id,
      meshId: meshId!,
      config: { modelName: model }
    })
  }

  if (!profile) {
    return
  }

  await applyAgentProfile(host.engine, {
    meshId: meshId!,
    agent,
    profile,
    sources: options.sources ?? {}
  })
  if (profile.toolConfigs) {
    await applyToolConfigs(host.engine, { meshId: meshId!, agent, configs: profile.toolConfigs })
  }

  // a list in qvac.config is the whole list, so the CLI's own skills are not added to it
  if (!profile.enabledSkills) {
    await enableSkills(host.engine, { meshId: meshId!, agent, names: host.cliSkills })
  }
}

// macOS hostnames follow the network (often an IP), so its Computer Name is the one people recognise.
function machineName() {
  if (process.platform === 'darwin') {
    const { stdout, status } = spawnSync('scutil', ['--get', 'ComputerName'])
    const name = status === 0 && stdout && b4a.toString(stdout).trim()
    if (name) {
      return name
    }
  }

  return os.hostname()
}

export async function bootCore(options: LaunchOptions = {}): Promise<CoreHost> {
  const core = await loadCoreModules()
  const started = Date.now()
  const paths = resolvePaths(options.entries)
  const invite = checkInvite(options, core.decodeMeshInvite)
  const env = process.env
  const root = options.dataDir || path.join(os.homedir(), '.qvac', 'cli')
  const modelName = options.fakeModels ? 'quack' : options.model || env['QVAC_MODEL'] || null
  const deviceName = options.deviceName || env['QVAC_DEVICE_NAME'] || machineName()
  const environment = env['QVAC_ENV'] || 'local'
  const storage = core.resolveStorage(core.releaseChannel(environment), {
    root,
    models: env[core.MODEL_CACHE_PATH_ENV] ?? null
  })
  if (storeInUse(storage.assistant)) {
    throw Object.assign(new Error(`another qvac is already using ${storage.root}`), {
      locked: true
    })
  }

  fs.mkdirSync(storage.assistant, { recursive: true })
  // mutates env before the spawn, so the children inherit the SDK paths
  const sdkConfigPath = core.configureSdkStorage(storage.sdk)
  const cliSkills = paths.cliSkillsDir
    ? installSkills(fs, { from: paths.cliSkillsDir, sdkConfigPath })
    : []

  const logFlags = {
    logFile: env['QVAC_LOG_FILE'] || path.join(storage.root, 'assistant.log'),
    logLevel: env['QVAC_LOG_LEVEL'],
    logVerbose: options.logVerbose
  }
  const device = {
    name: deviceName,
    capabilityProfile: 'mid',
    recommendedModelName: modelName || DEFAULT_MODEL
  }
  const { engine, exited } = await startSidecar({
    Client: core.Client,
    sidecarRunner: core.sidecarRunner,
    entry: paths.sidecarEntry,
    logger: new core.Logger(core.toLoggerOptions(logFlags)),
    config: sidecarConfig(options, { environment, storage, logFlags, paths, device })
  })
  const host: CoreHost = {
    engine,
    // the sidecar's exit code: at teardown, or when Core dies under a running host
    exited,
    close: () => engine.close(),
    skills: async (agentId: string, model: string, meshId: string) =>
      (await engine.skills({ agentId, modelName: model, meshId })).skills ?? [],
    deviceId: null,
    meshInvite: null,
    modelName,
    deviceName,
    cliSkills,
    root: storage.root,
    storagePath: storage.assistant,
    logFile: logFlags.logFile,
    connectMs: 0,
    configure: () => configureDevice(host, options)
  }
  try {
    await connectHost(host, { invite, options })
    host.connectMs = Date.now() - started

    return host
  } catch (error) {
    await host.close()
    throw error
  }
}
