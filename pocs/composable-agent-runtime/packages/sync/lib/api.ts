import type { CapabilityHandlers } from '../spec/rpc/capabilities.d.ts'
import type {
  RpcCreateTaskRequest,
  RpcTask,
  RpcUpdateTaskRequest
} from '../spec/rpc/hyperschema/types.d.ts'
import type { SyncTask } from '../spec/mesh/hyperschema/types.d.ts'
import type { LocalStore } from './local.ts'
import type { Mesh } from './mesh.ts'
import { watchable } from './watchable.ts'

const TASKS = '@sync/tasks'
const TASKS_BY_CREATED = '@sync/tasks-by-created'

export function createApi(
  local: LocalStore,
  mesh: Mesh,
  deviceId: Buffer,
  processId: number
): CapabilityHandlers {
  async function listTasks() {
    const rows = await mesh.view.find<SyncTask>(TASKS_BY_CREATED).toArray()
    return { tasks: rows as RpcTask[] }
  }

  async function createTask(request: RpcCreateTaskRequest): Promise<RpcTask> {
    const existing = await mesh.view.get<SyncTask>(TASKS, { id: request.id })
    if (existing) throw new Error(`Task already exists: ${request.id}`)
    const now = Date.now()
    const task: SyncTask = {
      ...request,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      originDeviceId: deviceId
    }
    await mesh.dispatch(task)
    return task as RpcTask
  }

  async function updateTask(request: RpcUpdateTaskRequest): Promise<RpcTask> {
    const existing = await mesh.view.get<SyncTask>(TASKS, { id: request.id })
    if (!existing) throw new Error(`Task not found: ${request.id}`)
    const task: SyncTask = {
      ...existing,
      ...(request.title == null ? null : { title: request.title }),
      ...(request.status == null ? null : { status: request.status }),
      ...(request.result == null ? null : { result: request.result }),
      updatedAt: Math.max(Date.now(), existing.updatedAt + 1)
    }
    await mesh.dispatch(task)
    return task as RpcTask
  }

  return {
    describeRuntime: async () => ({
      component: 'sync',
      runtime: 'bare',
      instanceId: `sync-${processId}`,
      processId,
      contract: 'qvac.sync',
      protocolVersion: 1,
      capabilities: [
        'local-profile',
        'tasks',
        'task-watches',
        'passive-replication'
      ],
      buildVersion: '0.0.0-poc'
    }),
    getIdentity: async () => ({ deviceId }),
    getUserProfile: async () => ({ profile: await local.getUserProfile() }),
    setUserProfile: async ({ name }) => {
      const trimmed = name.trim()
      if (!trimmed) throw new Error('User profile name must not be empty')
      return local.setUserProfile(trimmed)
    },
    watchUserProfile: watchable(local, async () => ({
      profile: await local.getUserProfile()
    })),
    createTask,
    updateTask,
    getTask: async ({ id }) => ({
      task: (await mesh.view.get<SyncTask>(TASKS, { id })) as RpcTask | null
    }),
    listTasks,
    watchTasks: watchable(mesh, listTasks)
  }
}
