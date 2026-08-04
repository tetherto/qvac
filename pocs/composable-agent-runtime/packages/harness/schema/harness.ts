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
      { name: 'progress', type: 'json' },
      { name: 'agentId', type: 'string' },
      { name: 'input', type: 'string' },
      { name: 'reason', type: 'string' },
      { name: 'data', type: 'json' },
      // Appended: hyperschema field order is part of the wire contract, so new
      // fields go at the end rather than where they read best.
      { name: 'approvalId', type: 'string' }
    ]
  })
}

export function registerHarnessApi(api: ApiNamespace) {
  for (const definition of harnessApi) api.register(definition)
}

export const harnessApi = [
  method('describe-runtime'),
  method('suspend'),
  method('resume'),
  method('run', true),
  method('list-skills'),
  method('register-agent'),
  method('run-agent', true),
  method('cancel-agent-run'),
  method('read-run'),
  method('watch-work', true),
  method('state-port', true),
  method('approvals', true)
] as const

function method(name: string, stream = false) {
  return {
    name,
    request: { name: '@harness/wire-frame', stream },
    response: { name: '@harness/wire-frame', stream }
  }
}
