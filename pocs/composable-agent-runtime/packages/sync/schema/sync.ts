export function registerLocalTypes(namespace: any) {
  namespace.register({
    name: 'user-profile',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'name', type: 'string', required: true }
    ]
  })
  namespace.register({
    name: 'mesh-session',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'seed', type: 'fixed32', required: true },
      { name: 'key', type: 'fixed32' },
      { name: 'creator', type: 'bool', required: true }
    ]
  })
}

export function registerLocalCollections(database: any) {
  database.collections.register({
    name: 'user-profile',
    schema: '@local/user-profile',
    key: ['id']
  })
  database.collections.register({
    name: 'mesh-session',
    schema: '@local/mesh-session',
    key: ['id']
  })
}

export function registerMeshTypes(namespace: any) {
  namespace.register({
    name: 'task-status',
    enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
    strings: true
  })
  namespace.register({
    name: 'task',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'title', type: 'string', required: true },
      { name: 'input', type: 'string', required: true },
      { name: 'status', type: '@sync/task-status', required: true },
      { name: 'result', type: 'string' },
      { name: 'createdAt', type: 'uint', required: true },
      { name: 'updatedAt', type: 'uint', required: true },
      { name: 'originDeviceId', type: 'fixed32', required: true }
    ]
  })
  namespace.register({
    name: 'put-task-operation',
    fields: [{ name: 'task', type: '@sync/task', required: true }]
  })
  namespace.register({
    name: 'update-task-operation',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'title', type: 'string' },
      { name: 'status', type: '@sync/task-status' },
      { name: 'result', type: 'string' },
      { name: 'updatedAt', type: 'uint', required: true }
    ]
  })
  namespace.register({
    name: 'add-writer-operation',
    fields: [{ name: 'key', type: 'fixed32', required: true }]
  })
}

export function registerMeshCollections(database: any) {
  database.collections.register({
    name: 'tasks',
    schema: '@sync/task',
    key: ['id']
  })
  database.indexes.register({
    name: 'tasks-by-created',
    collection: '@sync/tasks',
    unique: false,
    key: ['createdAt']
  })
}

export function registerMeshDispatch(dispatch: any) {
  dispatch.register({ name: 'put-task', requestType: '@sync/put-task-operation' })
  dispatch.register({ name: 'update-task', requestType: '@sync/update-task-operation' })
  dispatch.register({ name: 'add-writer', requestType: '@sync/add-writer-operation' })
}

export function registerRpcTypes(namespace: any) {
  namespace.register({ name: 'empty', fields: [] })
  namespace.register({
    name: 'runtime-info',
    fields: [
      { name: 'component', type: 'string', required: true },
      { name: 'runtime', type: 'string', required: true },
      { name: 'instanceId', type: 'string', required: true },
      { name: 'processId', type: 'uint', required: true },
      { name: 'contract', type: 'string', required: true },
      { name: 'protocolVersion', type: 'uint', required: true },
      { name: 'capabilities', type: 'string', array: true, required: true },
      { name: 'buildVersion', type: 'string', required: true }
    ]
  })
  namespace.register({
    name: 'identity',
    fields: [{ name: 'deviceId', type: 'fixed32', required: true }]
  })
  namespace.register({
    name: 'user-profile',
    fields: [{ name: 'name', type: 'string', required: true }]
  })
  namespace.register({
    name: 'user-profile-result',
    fields: [{ name: 'profile', type: '@rpc/user-profile' }]
  })
  namespace.register({
    name: 'task-status',
    enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
    strings: true
  })
  namespace.register({
    name: 'task',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'title', type: 'string', required: true },
      { name: 'input', type: 'string', required: true },
      { name: 'status', type: '@rpc/task-status', required: true },
      { name: 'result', type: 'string' },
      { name: 'createdAt', type: 'uint', required: true },
      { name: 'updatedAt', type: 'uint', required: true },
      { name: 'originDeviceId', type: 'fixed32', required: true }
    ]
  })
  namespace.register({
    name: 'create-task-request',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'title', type: 'string', required: true },
      { name: 'input', type: 'string', required: true }
    ]
  })
  namespace.register({
    name: 'update-task-request',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'title', type: 'string' },
      { name: 'status', type: '@rpc/task-status' },
      { name: 'result', type: 'string' }
    ]
  })
  namespace.register({
    name: 'task-id',
    fields: [{ name: 'id', type: 'string', required: true }]
  })
  namespace.register({
    name: 'task-result',
    fields: [{ name: 'task', type: '@rpc/task' }]
  })
  namespace.register({
    name: 'task-list',
    fields: [{ name: 'tasks', type: '@rpc/task', array: true, required: true }]
  })
  namespace.register({
    name: 'pairing-status',
    enum: ['pending', 'approved', 'rejected'],
    strings: true
  })
  namespace.register({
    name: 'create-pairing-invite-request',
    fields: [{ name: 'expiresInMs', type: 'uint' }]
  })
  namespace.register({
    name: 'pairing-invite',
    fields: [
      { name: 'id', type: 'fixed32', required: true },
      { name: 'invite', type: 'buffer', required: true },
      { name: 'expiresAt', type: 'uint', required: true }
    ]
  })
  namespace.register({
    name: 'pairing-request-id',
    fields: [{ name: 'id', type: 'fixed32', required: true }]
  })
  namespace.register({
    name: 'pairing-request',
    fields: [
      { name: 'id', type: 'fixed32', required: true },
      { name: 'writerKey', type: 'fixed32', required: true },
      { name: 'fingerprint', type: 'string', required: true },
      { name: 'status', type: '@rpc/pairing-status', required: true }
    ]
  })
  namespace.register({
    name: 'pairing-request-list',
    fields: [
      {
        name: 'requests',
        type: '@rpc/pairing-request',
        array: true,
        required: true
      }
    ]
  })
}

export function registerRpcApi(api: any) {
  const unary = (name: string, request: string, response: string) =>
    api.register({
      name,
      request: { name: request, stream: false },
      response: { name: response, stream: false }
    })
  const watch = (name: string, request: string, response: string) =>
    api.register({
      name,
      request: { name: request, stream: false },
      response: { name: response, stream: true }
    })

  unary('get-identity', '@rpc/empty', '@rpc/identity')
  unary('describe-runtime', '@rpc/empty', '@rpc/runtime-info')
  unary('get-user-profile', '@rpc/empty', '@rpc/user-profile-result')
  unary('set-user-profile', '@rpc/user-profile', '@rpc/user-profile')
  watch('watch-user-profile', '@rpc/empty', '@rpc/user-profile-result')
  unary('create-task', '@rpc/create-task-request', '@rpc/task')
  unary('update-task', '@rpc/update-task-request', '@rpc/task')
  unary('get-task', '@rpc/task-id', '@rpc/task-result')
  unary('list-tasks', '@rpc/empty', '@rpc/task-list')
  watch('watch-tasks', '@rpc/empty', '@rpc/task-list')
  unary(
    'create-pairing-invite',
    '@rpc/create-pairing-invite-request',
    '@rpc/pairing-invite'
  )
  unary('approve-pairing-request', '@rpc/pairing-request-id', '@rpc/pairing-request')
  unary('reject-pairing-request', '@rpc/pairing-request-id', '@rpc/pairing-request')
  watch('watch-pairing-requests', '@rpc/empty', '@rpc/pairing-request-list')
}
