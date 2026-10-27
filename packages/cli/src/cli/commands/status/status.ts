type Status = Awaited<ReturnType<typeof readStatus>> & {
  from?: string
  updatedAt?: string
  pid?: number
}
import type { RuntimeOptions } from '../../../lib/types.js'
import type { CoreHost } from '../../../lib/types.js'
import fs from 'bare-fs'
import path from 'bare-path'
import process from 'bare-process'
import { bytes } from '../../format.js'
import { readStatus } from '../../snapshot.js'
import type { CommandIO } from '@/cli/io.js'

export const SERVE_STATUS = 'cli-serve-status.json'

export async function status(host: CoreHost, options: RuntimeOptions, io: CommandIO) {
  printStatus(await readStatus(host), options, io)
  return 0
}

// The store has one writer, so beside a running serve this reads the copy serve keeps.
export function statusFromServe(options: RuntimeOptions, io: CommandIO) {
  const file = path.join(options.dataDir, SERVE_STATUS)
  if (!fs.existsSync(file)) {
    return null
  }

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  printStatus({ ...saved, from: 'qvac serve' }, options, io)

  return 0
}

export function writeServeStatus(dataDir: string, snapshot: Status) {
  const file = path.join(dataDir, SERVE_STATUS)
  fs.writeFileSync(
    file,
    JSON.stringify({ ...snapshot, pid: process.pid, updatedAt: new Date().toISOString() })
  )
}

export function clearServeStatus(dataDir: string) {
  fs.rmSync(path.join(dataDir, SERVE_STATUS), { force: true })
}

function printStatus(s: Status, options: RuntimeOptions, io: CommandIO) {
  if (options.json) {
    return io.json(s)
  }

  const rows: Array<[string, string]> = [
    ['Device', `${s.device.name} (${s.device.id?.slice(0, 12) ?? '?'})`],
    ['User', s.user ?? 'not set'],
    ['Workspace', workspaceText(s.workspaces)],
    ['Network', `${s.network.state} · ${peersText(s.network)}`],
    ['Devices', `${s.devices.length} in your account: ${s.devices.map((d) => d.name).join(', ')}`],
    ['Models', modelsText(s)],
    ['Storage', s.storage]
  ]
  if (!s.setUp) {
    rows.push(['Setup', 'not done yet: run qvac serve'])
  }

  if (s.from) {
    rows.push(['As of', `${s.updatedAt}, from the running qvac serve (pid ${s.pid})`])
  }

  io.line(`QV.AC ${options.version}`)
  for (const [label, value] of rows) {
    io.line(`${label.padEnd(11)}${value}`)
  }
}

function workspaceText(workspaces: Status['workspaces']) {
  if (!workspaces.length) {
    return 'none (qvac workspace create, or qvac workspace join <link>)'
  }

  return workspaces
    .map((w) => `${w.name} · ${w.state} · ${w.members} ${w.members === 1 ? 'member' : 'members'}`)
    .join('; ')
}

function peersText({ peerCount, peers }: Status['network']) {
  if (!peerCount) return 'no peers online'
  const named = peers.length ? `: ${peers.join(', ')}` : ''
  return `${peerCount} ${peerCount === 1 ? 'peer' : 'peers'} online${named}`
}

function modelsText({ models, memory }: Pick<Status, 'models' | 'memory'>) {
  const loaded = models.filter((m) => m.loaded)
  const parts = [
    `${models.length} on disk`,
    loaded.length ? `loaded: ${loaded.map((m) => m.name).join(', ')}` : 'none loaded'
  ]
  if (memory) {
    parts.push(`memory ${bytes(memory.usedBytes)} of ${bytes(memory.capBytes)}`)
  }

  return parts.join(' · ')
}
