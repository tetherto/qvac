import type { Capabilities } from '@qvac/core/client'
import b4a from 'b4a'

export function hex(value: Iterable<number> | string | null | undefined) {
  if (typeof value === 'string') return value
  return value ? b4a.toHex(b4a.from(value)) : ''
}

export async function snapshot(engine: Capabilities, workspaceId?: string | null) {
  // the account as Core holds it, as qvac status reads it: a pairing leaves no mesh row flagged
  const [account, { meshes = [] }, models] = await Promise.all([
    engine.account({}),
    engine.listMeshes({}),
    engine.listModels({ cachedOnly: true })
  ])
  const workspace =
    (meshes ?? []).find((m) => m.workspace && m.meshId === workspaceId) ||
    (meshes ?? []).find((m) => m.workspace)
  const scope = workspace?.meshId || account?.meshId
  const results = await Promise.allSettled([
    scope ? engine.listMembers({ meshId: scope }) : Promise.resolve({ members: [] }),
    account?.meshId
      ? engine.listDevices({ meshId: account.meshId })
      : Promise.resolve({ devices: [] }),
    account?.meshId
      ? engine.listAgents({ meshId: account.meshId })
      : Promise.resolve({ agents: [] }),
    workspace
      ? engine.listProjects({ meshId: workspace.meshId })
      : Promise.resolve({ projects: [] }),
    engine.getConfig({}),
    engine.diagnostics({}),
    scope ? engine.listDevices({ meshId: scope }) : Promise.resolve({ devices: [] }),
    workspace ? engine.getWorkspace({ meshId: workspace.meshId }) : Promise.resolve(null)
  ])
  const value = <T>(result: PromiseSettledResult<T>): T | null =>
    result.status === 'fulfilled' ? result.value : null
  const [
    members,
    devices,
    agents,
    projects,
    config,
    diagnostics,
    workspaceDevices,
    workspaceDetail
  ] = results
  const v = {
    members: value(members),
    devices: value(devices),
    agents: value(agents),
    projects: value(projects),
    config: value(config),
    diagnostics: value(diagnostics),
    workspaceDevices: value(workspaceDevices),
    workspaceDetail: value(workspaceDetail)
  }

  return {
    meshes: meshes ?? [],
    account,
    workspace: workspace ? { ...workspace, ...v.workspaceDetail } : null,
    models: models.models || [],
    memory: models.memory,
    members: v.members?.members,
    devices: v.devices?.devices,
    agents: v.agents?.agents,
    projects: v.projects?.projects,
    config: v.config,
    hardware: v.diagnostics?.stats,
    workspaceDevices: v.workspaceDevices?.devices,
    errors: results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message)
  }
}
