import type { Capabilities } from '@qvac/core/client'
import type { Agent } from '../lib/types.js'
import b4a from 'b4a'

const UPLOAD_FRAME_BYTES = 64 * 1024
// A fresh joiner's seed agent replicates shortly after join; past this we mint our own.
const AGENT_WAIT_MS = 4000

const same = (a: Iterable<number> | null | undefined, b: Iterable<number> | null | undefined) =>
  !!a && !!b && b4a.equals(b4a.from(a), b4a.from(b))
export const ownDefault = (agents: Agent[], deviceId: Uint8Array | null | undefined) =>
  agents.find((a) => a.isDefault && same(a.providerDeviceId, deviceId))

export async function accountMesh(engine: Capabilities) {
  for await (const account of engine.accountWatch({})) {
    if (account.meshId) {
      return account.meshId
    }
  }

  throw new Error('Core closed before this device held an account.')
}

export async function writable(engine: Capabilities, meshId: string) {
  for await (const frame of engine.meshesWatch({})) {
    if (frame.meshes?.find((m) => m.meshId === meshId)?.writable) return
  }

  throw new Error('Core closed before this workspace became writable.')
}

export async function chooseAgent(
  engine: Capabilities,
  meshId: string,
  {
    deviceId,
    remembered,
    modelName
  }: {
    deviceId: Uint8Array | null
    remembered?: string | null | undefined
    modelName?: string | null | undefined
  }
) {
  const watch = engine.agentsWatch({ meshId })[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined,
    agents: Agent[] = []
  const timeout = new Promise<IteratorReturnResult<undefined>>((resolve) => {
    timer = setTimeout(resolve, AGENT_WAIT_MS, { done: true, value: undefined })
  })
  try {
    while (true) {
      const { value, done } = await Promise.race([watch.next(), timeout])
      if (done) {
        break
      }

      agents = value.agents || []
      const found = agents.find((a) => a.id === remembered) || ownDefault(agents, deviceId)
      if (found) {
        return found
      }
    }
  } finally {
    clearTimeout(timer)
    await watch.return?.(undefined)
  }

  if (agents[0]) {
    return agents[0]
  }

  return createDefault(engine, meshId, { deviceId, modelName })
}

async function createDefault(
  engine: Capabilities,
  meshId: string,
  { deviceId, modelName }: { deviceId: Uint8Array | null; modelName?: string | null | undefined }
) {
  if (!deviceId) throw new Error('Core has not provided a device identity')
  const device = await engine.getDevice({ meshId, deviceId: b4a.from(deviceId) }).catch(() => null)

  const chosenModel = modelName || device?.recommendedModelName
  if (!chosenModel) throw new Error('Choose a model before creating a default agent')

  return engine.createAgent({
    meshId,
    config: {
      name: 'QV.AC',
      bio: 'You are a helpful local assistant. Be clear, practical, and concise.',
      providerDeviceId: b4a.from(deviceId),
      modelName: chosenModel,
      isDefault: true
    }
  })
}

export const visibleChats = (chats: Awaited<ReturnType<Capabilities['listChats']>>['chats'] = []) =>
  (chats ?? []).filter((c) => !c.deletedAt).reverse()

// setConfig replaces the whole record, so everything else rides along from the read.
export async function remember(
  engine: Capabilities,
  selection: { agentId?: string | null | undefined; chatId?: string | null | undefined }
) {
  const current = await engine.getConfig({})
  if (current.activeAgentId === selection.agentId && current.activeChatId === selection.chatId) {
    return
  }

  await engine.setConfig({
    ...current,
    activeAgentId: selection.agentId ?? null,
    activeChatId: selection.chatId ?? null
  })
}

async function write(
  stream: ReturnType<Capabilities['uploadAttachment']>,
  frame: Parameters<ReturnType<Capabilities['uploadAttachment']>['write']>[0]
) {
  if (stream.write(frame) === false) {
    await new Promise<void>((resolve) =>
      (stream as typeof stream & { once(event: 'drain', listener: () => void): void }).once(
        'drain',
        resolve
      )
    )
  }
}

export async function upload(
  engine: Capabilities,
  scope: { meshId: string; chatId: string },
  { fileName, mimeType, data }: { fileName: string; mimeType: string; data: Uint8Array }
) {
  const duplex = engine.uploadAttachment()
  await write(duplex, { ...scope, fileName, mimeType, totalBytes: data.length })
  for (let at = 0; at < data.length; at += UPLOAD_FRAME_BYTES) {
    await write(duplex, { data: b4a.from(data.subarray(at, at + UPLOAD_FRAME_BYTES)) })
  }

  duplex.end()
  let last = null
  for await (const frame of duplex) {
    last = frame
  }

  return last
}

// One step of a Core watch as a bare-tui command; the caller re-arms it on each frame.
export function follow<T>(iterator: AsyncIterator<T>, type: string, tag?: number) {
  return async () => {
    try {
      const { value, done } = await iterator.next()
      return done ? { type: `${type}.end`, tag } : { type, tag, value }
    } catch (error) {
      return { type: `${type}.end`, tag, error }
    }
  }
}
