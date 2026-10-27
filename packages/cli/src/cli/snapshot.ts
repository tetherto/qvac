import type { Capabilities } from '@qvac/core/client'
type Device = NonNullable<Awaited<ReturnType<Capabilities['listDevices']>>['devices']>[number]
type Mesh = NonNullable<Awaited<ReturnType<Capabilities['listMeshes']>>['meshes']>[number]
import type { CoreHost } from '../lib/types.js'
import b4a from 'b4a'

const hex = (id: Iterable<number> | null | undefined) => (id ? b4a.toHex(b4a.from(id)) : null)

export async function firstFrame<T>(stream: AsyncIterable<T>): Promise<T | null> {
  for await (const frame of stream) {
    return frame
  }

  return null
}

// One read of everything `qvac status` shows; serve keeps a copy of it on disk for status to read.
export async function readStatus(host: CoreHost) {
  const { engine } = host
  const [account, { meshes }, config, mesh, models] = await Promise.all([
    engine.account({}),
    engine.listMeshes({}),
    engine.getConfig({}),
    firstFrame(engine.meshStatusWatch({})),
    engine.listModels({ cachedOnly: true })
  ])
  const { devices } = await engine.listDevices({ meshId: account.meshId! })
  const live = (devices ?? []).filter((device) => !device.revoked)
  const self = hex(host.deviceId)
  const name = (id: string) => live.find((device) => hex(device.id) === id)?.name ?? id.slice(0, 8)

  return {
    device: { id: self, name: ownName(host, live) },
    user: account.displayName ?? null,
    setUp: !!config.onboardingCompleted,
    network: {
      state: mesh?.state ?? 'idle',
      peers: (mesh?.peerDeviceIds ?? []).map(name),
      peerCount: mesh?.peerCount ?? 0
    },
    devices: live.map((device) => ({
      id: hex(device.id),
      name: device.name,
      platform: device.platform ?? null
    })),
    workspaces: await workspaces(engine, meshes ?? []),
    models: (models.models ?? []).map((model) => ({
      name: model.name,
      loaded: !!model.isLoaded,
      size: model.actualSize ?? model.expectedSize
    })),
    memory: models.memory ?? null,
    storage: host.root
  }
}

function workspaces(engine: Capabilities, meshes: Mesh[]) {
  return Promise.all(
    meshes.filter((mesh) => mesh.workspace).map((mesh) => workspaceInfo(engine, mesh))
  )
}

// Naming a mesh opens it on demand, so a closed workspace still answers with its name and people.
export async function workspaceInfo(engine: Capabilities, mesh: Mesh) {
  const [workspace, { members }] = await Promise.all([
    engine.getWorkspace({ meshId: mesh.meshId }),
    engine.listMembers({ meshId: mesh.meshId })
  ])

  return {
    meshId: mesh.meshId,
    name: workspace.name || mesh.label || 'Workspace',
    state: mesh.state,
    members: (members ?? []).filter((member) => !member.removed).length
  }
}

export async function joinedWorkspaces(engine: Capabilities) {
  const { meshes } = await engine.listMeshes({})
  return workspaces(
    engine,
    (meshes ?? []).filter((mesh: { state: string }) => mesh.state !== 'joining')
  )
}

export async function thisDevice(host: CoreHost) {
  const { meshId } = await host.engine.account({})
  const { devices } = await host.engine.listDevices({ meshId: meshId! })

  return ownName(host, devices ?? [])
}

function ownName(host: CoreHost, devices: Device[]) {
  const self = hex(host.deviceId)
  return devices.find((device) => hex(device.id) === self)?.name ?? host.deviceName
}
