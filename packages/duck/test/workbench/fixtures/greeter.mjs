import { PluginRegistry } from '@qvac/harness/plugins'

export class Greeter {
  constructor(options = {}) {
    this.name = 'greeter'
    this.api = PluginRegistry.API_VERSION
    this.greeting = options.greeting || 'Hello'
  }

  setup() {
    return {
      tools: [
        {
          name: 'greet',
          description: 'Greet someone by name.',
          toolset: 'team',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Who to greet' } },
            required: ['name']
          },
          effect: () => 'read',
          execute: (args) => Promise.resolve({ content: `${this.greeting}, ${args.name}!` })
        }
      ]
    }
  }
}
