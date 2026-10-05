import test from 'brittle'
import { z } from 'zod'
import { toolSchema, type Tool } from '@/schemas'
import { convertToolInput } from '@/utils/tool-helpers'
import { getMcpTools } from '@/utils/mcp-adapter'
import type { McpClient } from '@/schemas/mcp-adapter'

test('toolSchema keeps nested parameter keywords', (t) => {
  const tool = {
    type: 'function',
    name: 'plan_trip',
    description: 'Plan a trip',
    parameters: {
      type: 'object',
      $defs: { stop: { type: 'object', properties: { name: { type: 'string' } } } },
      properties: {
        stops: { type: 'array', items: { $ref: '#/$defs/stop' }, minItems: 1 },
        options: {
          type: 'object',
          properties: { budget: { type: ['number', 'null'] } },
          required: ['budget'],
          additionalProperties: false
        },
        when: { anyOf: [{ type: 'string' }, { type: 'null' }] }
      },
      required: ['stops']
    }
  }
  const parsed = toolSchema.parse(tool)
  t.alike(parsed, tool)
})

test('toolSchema still rejects an unknown parameter type', (t) => {
  const result = toolSchema.safeParse({
    type: 'function',
    name: 'x',
    description: 'x',
    parameters: { type: 'object', properties: { a: { type: 'date' } } }
  })
  t.is(result.success, false)
})

test('convertToolInput keeps nested Zod structure', (t) => {
  const tool = convertToolInput({
    name: 'plan_trip',
    description: 'Plan a trip',
    parameters: z.object({
      stops: z.array(z.object({ name: z.string(), at: z.string().nullable() })),
      days: z.number().int().optional(),
      unit: z.enum(['km', 'mi']).describe('Distance unit')
    })
  })
  const { properties, required } = tool.parameters
  t.alike(required, ['stops', 'unit'])
  t.alike(properties['stops'], {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        at: { anyOf: [{ type: 'string' }, { type: 'null' }] }
      },
      required: ['name', 'at']
    }
  })
  t.alike(properties['days'], { type: 'integer' }, 'safe-integer bounds are dropped')
  t.alike(properties['unit'], { type: 'string', enum: ['km', 'mi'], description: 'Distance unit' })
  t.absent((tool.parameters as Record<string, unknown>)['$schema'])
})

test('getMcpTools passes MCP input schemas through', async (t) => {
  const client = {
    listTools: async () => ({
      tools: [
        {
          name: 'query',
          inputSchema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            $defs: { row: { type: 'object' } },
            properties: {
              rows: { type: 'array', items: { $ref: '#/$defs/row' } },
              cursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              legacy: { type: 'date' }
            },
            required: ['rows']
          }
        }
      ]
    })
  } as unknown as McpClient
  const [tool] = (await getMcpTools([{ client, includeResources: false }])) as [Tool]
  const parameters = tool.parameters as Record<string, unknown>
  t.alike(parameters['$defs'], { row: { type: 'object' } })
  t.absent(parameters['$schema'])
  t.alike(tool.parameters.properties['rows'], { type: 'array', items: { $ref: '#/$defs/row' } })
  t.alike(tool.parameters.properties['cursor'], { anyOf: [{ type: 'string' }, { type: 'null' }] })
  t.is(tool.parameters.properties['legacy']?.type, 'string', 'an unknown type falls back to string')
  t.ok(toolSchema.safeParse(tool).success)
})
