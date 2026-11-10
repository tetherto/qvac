import type { AgentProfile, WorkbenchConfig } from '../types.js'
import fs from '#fs'
import path from '#path'
import { codingInstructions } from './agent-profile.js'
import { workFolder, testCommand } from './project.js'

const GIB = 1024 ** 3

const TOOLCHAINS = [
  '/opt/homebrew',
  '/usr/local',
  '~/.nvm',
  '~/.cargo',
  '~/.rustup',
  '~/.pyenv',
  '~/.bun',
  '~/.deno',
  '~/.gitconfig'
]

const SANDBOX: Record<string, string> = {
  darwin: 'sandbox-macos',
  linux: 'sandbox-linux',
  win32: 'sandbox-windows'
}

export function autoModel(totalMemoryBytes: number) {
  if (totalMemoryBytes >= 16 * GIB) return 'Qwen3.5-9B-Q4_K_M'
  if (totalMemoryBytes >= 8 * GIB) return 'Qwen3.5-4B-Q4_K_M'
  return 'Qwen3.5-2B-Q4_K_M'
}

// Local subagents share the model's KV slots, so how many run at once follows memory.
export function delegateSlots(totalMemoryBytes: number) {
  if (totalMemoryBytes >= 32 * GIB) return 3
  if (totalMemoryBytes >= 16 * GIB) return 2
  return 1
}

export const resolveModel = (model: string, totalMemoryBytes: number) =>
  !model || model === 'auto' ? autoModel(totalMemoryBytes) : model

// Billions of parameters from a name like Qwen3.5-9B-Q4_K_M; null when the name does not say.
export function modelBillions(model: string) {
  const match = /-(\d+(?:\.\d+)?)B(?=[-_]|$)/.exec(model)
  return match ? Number(match[1]) : null
}

export function defaultPlugins(platform: string) {
  const sandbox = SANDBOX[platform]
  const coding = platform === 'win32' ? [] : [{ id: 'coding' }]
  return [...coding, ...(sandbox ? [{ id: sandbox }] : []), { id: 'lsp', optional: true }]
}

// The sandbox confines files; the network stays open, as in Claude Code, until a config limits it.
export function defaultPolicy({
  root,
  home,
  developerDir = null,
  exists
}: {
  root: string
  home: string
  developerDir?: string | null
  exists(path: string): boolean
}) {
  const reads = [...TOOLCHAINS.map((p) => p.replace(/^~(?=\/)/, home)), developerDir]
    .filter((p): p is string => !!p)
    .filter((p) => exists(p))
  return {
    files: { read: [root, ...reads], write: [root] },
    network: { mode: 'on' as const }
  }
}

export function defaults({
  cwd,
  platform,
  totalMemoryBytes,
  home,
  model = 'auto',
  developerDir = platform === 'darwin' ? xcodeDeveloperDir() : null,
  exists = fs.existsSync
}: {
  cwd: string
  platform: string
  totalMemoryBytes: number
  home: string
  model?: string | undefined
  developerDir?: string | null
  exists?: (path: string) => boolean
}): Partial<WorkbenchConfig> {
  const root = workFolder(cwd, { existsSync: exists }, { home })
  const chosen = resolveModel(model, totalMemoryBytes)
  if (!root) {
    return { core: { model: 'auto' }, harness: { maxToolRounds: 20 } }
  }

  const agent: AgentProfile = {
    instructions: codingInstructions({ root, test: testCommand(root, fs) })
  }
  const plugins = defaultPlugins(platform)
  // exec runs one program outside the sandbox; with the coding shell a model would pick between them
  if (plugins.some((p) => p.id === 'coding')) {
    agent.disabledToolsets = ['exec']
  }

  if ((modelBillions(chosen) ?? 0) >= 9) {
    agent.reasoning = 'enabled'
  }

  return {
    core: { model: 'auto', folders: [{ path: root, write: true }], agent },
    harness: {
      maxToolRounds: 40,
      delegation: { slots: delegateSlots(totalMemoryBytes) },
      plugins,
      policy: defaultPolicy({ root, home, developerDir, exists })
    }
  }
}

// What xcode-select chose, read from the link it writes, so no process is spawned.
export function xcodeDeveloperDir(readlink = fs.readlinkSync) {
  try {
    return path.resolve(readlink('/var/db/xcode_select_link'))
  } catch {
    return null
  }
}
