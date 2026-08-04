export function registerLocalTypes(namespace: any) {
  namespace.register({
    name: 'mesh-session',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'seed', type: 'fixed32', required: true },
      { name: 'key', type: 'fixed32' },
      { name: 'writerSeed', type: 'fixed32' },
      { name: 'creator', type: 'bool', required: true }
    ]
  })
  namespace.register({
    name: 'device',
    fields: [
      { name: 'id', type: 'fixed32', required: true },
      { name: 'name', type: 'string', required: true }
    ]
  })
}

export function registerLocalCollections(database: any) {
  database.collections.register({
    name: 'mesh-session',
    schema: '@local/mesh-session',
    key: ['id']
  })
  database.collections.register({
    name: 'device',
    schema: '@local/device',
    key: ['id']
  })
}

export function registerMeshTypes(namespace: any) {
  namespace.register({
    name: 'add-writer-operation',
    fields: [{ name: 'key', type: 'fixed32', required: true }]
  })
  namespace.register({
    name: 'device',
    fields: [
      { name: 'id', type: 'fixed32', required: true },
      { name: 'writerKey', type: 'fixed32', required: true },
      { name: 'name', type: 'string', required: true },
      { name: 'joinedAt', type: 'uint', required: true },
      { name: 'revokedAt', type: 'uint' }
    ]
  })
  namespace.register({
    name: 'put-device-operation',
    fields: [{ name: 'device', type: '@sync/device', required: true }]
  })
  namespace.register({
    name: 'rename-device-operation',
    fields: [
      { name: 'id', type: 'fixed32', required: true },
      { name: 'name', type: 'string', required: true }
    ]
  })
  namespace.register({
    name: 'remove-writer-operation',
    fields: [
      { name: 'id', type: 'fixed32', required: true },
      { name: 'writerKey', type: 'fixed32', required: true },
      { name: 'revokedAt', type: 'uint', required: true }
    ]
  })
  namespace.register({
    name: 'profile-operation',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'profileId', type: 'string', required: true },
      { name: 'revision', type: 'string', required: true },
      { name: 'command', type: 'buffer', required: true }
    ]
  })
  namespace.register({
    name: 'profile-head',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'revision', type: 'string', required: true }
    ]
  })
  namespace.register({
    name: 'apply-profile-operation',
    fields: [
      { name: 'profileId', type: 'string', required: true },
      { name: 'operationId', type: 'string', required: true },
      { name: 'revision', type: 'string', required: true },
      { name: 'expectedRevision', type: 'string' },
      { name: 'command', type: 'buffer', required: true },
      { name: 'inputCommand', type: 'buffer', required: true },
      { name: 'deviceId', type: 'fixed32', required: true },
      { name: 'recordedAt', type: 'uint', required: true }
    ]
  })
  namespace.register({
    name: 'durable-work-outcome-status',
    enum: ['completed', 'failed', 'cancelled'],
    strings: true
  })
  namespace.register({
    name: 'durable-work',
    fields: [
      { name: 'workId', type: 'string', required: true },
      { name: 'payload', type: 'buffer', required: true },
      { name: 'payloadFormat', type: 'string', required: true },
      { name: 'payloadVersion', type: 'uint', required: true },
      { name: 'target', type: 'string' },
      { name: 'createdAt', type: 'uint', required: true },
      { name: 'cancelRequested', type: 'bool', required: true },
      { name: 'cancelReason', type: 'string' },
      { name: 'outcomeStatus', type: '@sync/durable-work-outcome-status' },
      { name: 'outcomeResult', type: 'buffer' }
    ]
  })
  namespace.register({
    name: 'durable-work-journal-entry',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'workId', type: 'string', required: true },
      { name: 'entryType', type: 'string', required: true },
      { name: 'body', type: 'buffer', required: true },
      { name: 'recordedAt', type: 'uint', required: true }
    ]
  })
  namespace.register({
    name: 'durable-work-checkpoint',
    fields: [
      { name: 'workId', type: 'string', required: true },
      { name: 'checkpointId', type: 'string', required: true },
      { name: 'format', type: 'string', required: true },
      { name: 'version', type: 'uint', required: true },
      { name: 'blobRef', type: 'string', required: true },
      { name: 'recordedAt', type: 'uint', required: true }
    ]
  })
  namespace.register({
    name: 'durable-work-gate',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'workId', type: 'string', required: true },
      { name: 'gateId', type: 'string', required: true },
      { name: 'kind', type: 'string', required: true },
      { name: 'decision', type: 'string' },
      { name: 'recordedAt', type: 'uint', required: true }
    ]
  })
  namespace.register({
    name: 'durable-work-executor',
    fields: [
      { name: 'executorId', type: 'string', required: true },
      { name: 'capabilities', type: 'string', array: true, required: true },
      { name: 'expiresAt', type: 'uint', required: true },
      { name: 'recordedAt', type: 'uint', required: true }
    ]
  })
}

export function registerMeshCollections(database: any) {
  database.collections.register({
    name: 'profile-operations',
    schema: '@sync/profile-operation',
    key: ['id']
  })
  database.collections.register({
    name: 'devices',
    schema: '@sync/device',
    key: ['id']
  })
  database.collections.register({
    name: 'profile-heads',
    schema: '@sync/profile-head',
    key: ['id']
  })
  database.collections.register({
    name: 'durable-work',
    schema: '@sync/durable-work',
    key: ['workId']
  })
  database.collections.register({
    name: 'durable-work-journal',
    schema: '@sync/durable-work-journal-entry',
    key: ['id']
  })
  database.collections.register({
    name: 'durable-work-checkpoints',
    schema: '@sync/durable-work-checkpoint',
    key: ['workId']
  })
  database.collections.register({
    name: 'durable-work-gates',
    schema: '@sync/durable-work-gate',
    key: ['id']
  })
  database.collections.register({
    name: 'durable-work-executors',
    schema: '@sync/durable-work-executor',
    key: ['executorId']
  })
}

export function registerMeshDispatch(dispatch: any) {
  dispatch.register({ name: 'add-writer', requestType: '@sync/add-writer-operation' })
  dispatch.register({ name: 'put-device', requestType: '@sync/put-device-operation' })
  dispatch.register({ name: 'rename-device', requestType: '@sync/rename-device-operation' })
  dispatch.register({ name: 'remove-writer', requestType: '@sync/remove-writer-operation' })
  dispatch.register({
    name: 'apply-profile',
    requestType: '@sync/apply-profile-operation'
  })
}

export function registerRpcTypes(namespace: any) {
  namespace.register({ name: 'empty', fields: [] })
  namespace.register({
    name: 'ok',
    fields: [{ name: 'ok', type: 'bool', required: true }]
  })
  namespace.register({
    name: 'runtime-phase',
    enum: ['opening', 'ready', 'suspended', 'failed', 'closed'],
    strings: true
  })
  namespace.register({
    name: 'network-state',
    enum: ['stopped', 'starting', 'online', 'offline', 'degraded'],
    strings: true
  })
  namespace.register({
    name: 'runtime-status',
    fields: [
      { name: 'phase', type: '@rpc/runtime-phase', required: true },
      { name: 'generation', type: 'string', required: true },
      { name: 'network', type: '@rpc/network-state', required: true },
      { name: 'writable', type: 'bool', required: true },
      { name: 'peerCount', type: 'uint', required: true }
    ]
  })
  namespace.register({
    name: 'runtime-child-diagnostic',
    fields: [
      { name: 'name', type: 'string', required: true },
      { name: 'state', type: 'string', required: true },
      { name: 'deps', type: 'string', array: true, required: true },
      { name: 'networkInstanceId', type: 'string' },
      { name: 'topicPresent', type: 'bool' },
      { name: 'discoveryTeardownComplete', type: 'bool' }
    ]
  })
  namespace.register({
    name: 'runtime-diagnostics',
    fields: [
      {
        name: 'children',
        type: '@rpc/runtime-child-diagnostic',
        array: true,
        required: true
      }
    ]
  })
  namespace.register({
    name: 'mesh-status-state',
    enum: ['idle', 'joining', 'joined', 'leaving', 'kicked', 'error'],
    strings: true
  })
  namespace.register({
    name: 'mesh-status',
    fields: [
      { name: 'state', type: '@rpc/mesh-status-state', required: true },
      { name: 'generation', type: 'string', required: true },
      { name: 'meshKey', type: 'fixed32' },
      { name: 'discoveryKey', type: 'fixed32' },
      { name: 'writable', type: 'bool', required: true },
      { name: 'peerCount', type: 'uint', required: true },
      { name: 'network', type: '@rpc/network-state', required: true }
    ]
  })
  namespace.register({
    name: 'mesh-join-request',
    fields: [{ name: 'invite', type: 'buffer', required: true }]
  })
  namespace.register({
    name: 'device',
    fields: [
      { name: 'id', type: 'fixed32', required: true },
      { name: 'name', type: 'string', required: true },
      { name: 'local', type: 'bool', required: true },
      { name: 'joinedAt', type: 'uint', required: true },
      { name: 'revokedAt', type: 'uint' }
    ]
  })
  namespace.register({
    name: 'device-list',
    fields: [{ name: 'devices', type: '@rpc/device', array: true, required: true }]
  })
  namespace.register({
    name: 'rename-device-request',
    fields: [{ name: 'name', type: 'string', required: true }]
  })
  namespace.register({
    name: 'remove-device-request',
    fields: [{ name: 'id', type: 'fixed32', required: true }]
  })
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
  namespace.register({
    name: 'profile-apply-request',
    fields: [
      { name: 'profileId', type: 'string', required: true },
      { name: 'version', type: 'uint', required: true },
      { name: 'generation', type: 'string', required: true },
      { name: 'operationId', type: 'string', required: true },
      { name: 'expectedRevision', type: 'string' },
      { name: 'traceId', type: 'string' },
      { name: 'command', type: 'buffer', required: true }
    ]
  })
  namespace.register({
    name: 'profile-apply-result',
    fields: [{ name: 'revision', type: 'string', required: true }]
  })
  namespace.register({
    name: 'profile-query-request',
    fields: [
      { name: 'profileId', type: 'string', required: true },
      { name: 'version', type: 'uint', required: true },
      { name: 'generation', type: 'string', required: true },
      { name: 'query', type: 'buffer', required: true }
    ]
  })
  namespace.register({
    name: 'profile-query-result',
    fields: [{ name: 'value', type: 'buffer', required: true }]
  })
  namespace.register({
    name: 'profile-watch-request',
    fields: [
      { name: 'profileId', type: 'string', required: true },
      { name: 'version', type: 'uint', required: true },
      { name: 'generation', type: 'string', required: true },
      { name: 'query', type: 'buffer', required: true },
      { name: 'after', type: 'string' }
    ]
  })
  namespace.register({
    name: 'profile-watch-kind',
    enum: ['snapshot', 'change'],
    strings: true
  })
  namespace.register({
    name: 'profile-watch-frame',
    fields: [
      { name: 'kind', type: '@rpc/profile-watch-kind', required: true },
      { name: 'generation', type: 'string', required: true },
      { name: 'cursor', type: 'string', required: true },
      { name: 'value', type: 'buffer' },
      { name: 'change', type: 'buffer' }
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
  unary('runtime-status', '@rpc/empty', '@rpc/runtime-status')
  unary('runtime-diagnostics', '@rpc/empty', '@rpc/runtime-diagnostics')
  unary('suspend', '@rpc/empty', '@rpc/ok')
  unary('resume', '@rpc/empty', '@rpc/ok')
  unary('mesh-status', '@rpc/empty', '@rpc/mesh-status')
  watch('watch-mesh-status', '@rpc/empty', '@rpc/mesh-status')
  unary('join-mesh', '@rpc/mesh-join-request', '@rpc/ok')
  unary('cancel-mesh-join', '@rpc/empty', '@rpc/ok')
  unary('leave-mesh', '@rpc/empty', '@rpc/ok')
  unary('list-devices', '@rpc/empty', '@rpc/device-list')
  watch('watch-devices', '@rpc/empty', '@rpc/device-list')
  unary('rename-device', '@rpc/rename-device-request', '@rpc/device')
  unary('remove-device', '@rpc/remove-device-request', '@rpc/ok')
  unary(
    'create-pairing-invite',
    '@rpc/create-pairing-invite-request',
    '@rpc/pairing-invite'
  )
  unary('approve-pairing-request', '@rpc/pairing-request-id', '@rpc/pairing-request')
  unary('reject-pairing-request', '@rpc/pairing-request-id', '@rpc/pairing-request')
  watch('watch-pairing-requests', '@rpc/empty', '@rpc/pairing-request-list')
  unary('apply-profile', '@rpc/profile-apply-request', '@rpc/profile-apply-result')
  unary('query-profile', '@rpc/profile-query-request', '@rpc/profile-query-result')
  watch('watch-profile', '@rpc/profile-watch-request', '@rpc/profile-watch-frame')
}
