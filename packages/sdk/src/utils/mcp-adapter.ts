import type { Tool } from '@qvac/inference/surface'
import type { JsonSchema } from '@qvac/inference/surface'
import type { McpClientInput, McpClient } from '@qvac/inference/surface'
import type { ToolHandler } from '@/utils/tool-helpers'
import { mapValues } from '@/utils/object'

export type { McpClient, McpClientInput } from '@qvac/inference/surface'

export type ToolHandlerMap = Map<string, ToolHandler>

export type McpToolsResult = {
  tools: Tool[]
  handlers: ToolHandlerMap
}

const VALID_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const

type ValidType = (typeof VALID_TYPES)[number]
type ToolParameter = Tool['parameters']['properties'][string]

function isValidType(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isValidType)
  return typeof value === 'string' && VALID_TYPES.includes(value as ValidType)
}

function convertMcpToolToTool(mcpTool: {
  name: string
  description?: string | undefined
  inputSchema: JsonSchema | Record<string, unknown>
}): Tool {
  // `$defs` and other top-level keywords stay, so a nested `$ref` still resolves.
  const { $schema: _schema, title: _title, ...inputSchema } = mcpTool.inputSchema as JsonSchema
  const properties = inputSchema.properties ?? {}
  const required = inputSchema.required ?? []

  // Only an unrecognised `type` is replaced; a missing one is left alone because
  // `anyOf`/`oneOf` properties carry their types in the branches.
  const convertedProperties = mapValues(properties, (prop): ToolParameter => {
    const { type } = prop as { type?: unknown }
    return type === undefined || isValidType(type)
      ? (prop as ToolParameter)
      : { ...(prop as ToolParameter), type: 'string' }
  })

  return {
    type: 'function',
    name: mcpTool.name,
    description: mcpTool.description ?? '',
    parameters: {
      ...inputSchema,
      type: 'object',
      properties: convertedProperties,
      required: required.length > 0 ? required : undefined
    }
  }
}

function createMcpToolHandler(client: McpClient, toolName: string): ToolHandler {
  return async (args: Record<string, unknown>) => {
    return client.callTool({ name: toolName, arguments: args })
  }
}

export async function getMcpToolsWithHandlers(clients: McpClientInput[]): Promise<McpToolsResult> {
  const allTools: Tool[] = []
  const handlers: ToolHandlerMap = new Map()

  for (const { client, includeResources, deferLoading, group } of clients) {
    const start = allTools.length
    const { tools: mcpTools } = await client.listTools()

    for (const mcpTool of mcpTools) {
      allTools.push(convertMcpToolToTool(mcpTool))
      handlers.set(mcpTool.name, createMcpToolHandler(client, mcpTool.name))
    }

    if (includeResources !== false && client.listResources) {
      allTools.push({
        type: 'function',
        name: 'list_resources',
        description: 'List available resources from MCP server',
        parameters: {
          type: 'object',
          properties: {}
        }
      })
      handlers.set('list_resources', async () => {
        if (!client.listResources) {
          return { resources: [] }
        }
        const result = await client.listResources()
        return {
          type: 'text',
          text: JSON.stringify(result.resources, null, 2)
        }
      })

      if (client.readResource) {
        allTools.push({
          type: 'function',
          name: 'read_resource',
          description: 'Read content of a specific resource by URI',
          parameters: {
            type: 'object',
            properties: {
              uri: {
                type: 'string',
                description: 'The URI of the resource to read'
              }
            },
            required: ['uri']
          }
        })
        handlers.set('read_resource', async (args) => {
          if (!client.readResource) {
            return { error: 'readResource not available' }
          }
          const result = await client.readResource({
            uri: args['uri'] as string
          })
          return result.contents[0]
        })
      }
    }

    if (deferLoading === true) {
      for (let i = start; i < allTools.length; i++) {
        allTools[i] = { ...allTools[i]!, deferLoading: true, ...(group !== undefined && { group }) }
      }
    }
  }

  return { tools: allTools, handlers }
}

export async function getMcpTools(clients: McpClientInput[]): Promise<Tool[]> {
  const { tools } = await getMcpToolsWithHandlers(clients)
  return tools
}
