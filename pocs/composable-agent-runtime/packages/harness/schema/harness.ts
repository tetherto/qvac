interface SchemaNamespace {
  register(definition: {
    readonly name: string
    readonly fields: readonly {
      readonly name: string
      readonly type: string
      readonly required?: boolean
      readonly array?: boolean
    }[]
  }): void
}

interface ApiNamespace {
  register(definition: {
    readonly name: string
    readonly request: { readonly name: string; readonly stream: boolean }
    readonly response: { readonly name: string; readonly stream: boolean }
  }): void
}

export function registerHarnessTypes(namespace: SchemaNamespace) {
  namespace.register({
    name: 'wire-frame',
    fields: [
      { name: 'type', type: 'string', required: true },
      { name: 'runId', type: 'string' },
      { name: 'model', type: 'string' },
      { name: 'messages', type: 'json' },
      { name: 'text', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'args', type: 'json' },
      { name: 'result', type: 'json' },
      { name: 'metrics', type: 'json' },
      { name: 'message', type: 'string' },
      { name: 'traceId', type: 'string' },
      { name: 'component', type: 'string' },
      { name: 'runtime', type: 'string' },
      { name: 'instanceId', type: 'string' },
      { name: 'processId', type: 'uint' },
      { name: 'contract', type: 'string' },
      { name: 'protocolVersion', type: 'uint' },
      { name: 'capabilities', type: 'json' },
      { name: 'buildVersion', type: 'string' },
      { name: 'sdkIdentity', type: 'json' },
      { name: 'error', type: 'json' },
      { name: 'progress', type: 'json' }
    ]
  })
}

export function registerHarnessApi(api: ApiNamespace) {
  api.register({
    name: 'describe-runtime',
    request: { name: '@harness/wire-frame', stream: false },
    response: { name: '@harness/wire-frame', stream: false }
  })
  api.register({
    name: 'run',
    request: { name: '@harness/wire-frame', stream: true },
    response: { name: '@harness/wire-frame', stream: true }
  })
}
