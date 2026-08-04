interface SchemaNamespace {
  register(definition: {
    readonly name: string
    readonly fields: readonly {
      readonly name: string
      readonly type: string
      readonly required?: boolean
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

export function registerToolSandboxTypes(namespace: SchemaNamespace) {
  namespace.register({
    name: 'wire-frame',
    fields: [
      { name: 'type', type: 'string', required: true },
      { name: 'invocationId', type: 'string' },
      { name: 'generation', type: 'uint' },
      { name: 'toolName', type: 'string' },
      { name: 'input', type: 'json' },
      { name: 'value', type: 'json' },
      { name: 'code', type: 'string' },
      { name: 'message', type: 'string' },
      { name: 'component', type: 'string' },
      { name: 'runtime', type: 'string' },
      { name: 'processId', type: 'uint' },
      { name: 'protocolVersion', type: 'uint' },
      { name: 'configuration', type: 'json' }
    ]
  })
}

export function registerToolSandboxApi(api: ApiNamespace) {
  for (const name of ['describe', 'configure', 'invoke', 'cancel']) {
    api.register({
      name,
      request: { name: '@tool-sandbox/wire-frame', stream: false },
      response: { name: '@tool-sandbox/wire-frame', stream: false }
    })
  }
}
