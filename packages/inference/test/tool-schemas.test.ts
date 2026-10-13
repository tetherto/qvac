import test from 'brittle'
import { z } from 'zod'
import { toolSchema, type Tool } from '@/schemas'
import { convertToolInput } from '@/utils/tool-helpers'
import { getMcpTools } from '@/utils/mcp-adapter'
import { parameterAllowsNull, parameterTypes } from '@/utils/tools/shared'
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
  const stops = properties['stops'] as {
    type: string
    items: { type: string; properties: Record<string, unknown>; required: string[] }
  }
  t.is(stops.type, 'array')
  t.is(stops.items.type, 'object')
  t.alike(stops.items.properties['name'], { type: 'string' })
  t.alike(stops.items.required, ['name', 'at'])
  // Zod versions differ between `anyOf` and a type array for nullables.
  const at = stops.items.properties['at']
  t.alike(parameterTypes(at), ['string'])
  t.ok(parameterAllowsNull(at))
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
