import { z } from 'zod'
import { toolSchema, type Tool, type ToolCall, type ToolCallWithCall } from '@/schemas/tools'
import { InvalidToolsArrayError, InvalidToolSchemaError } from '@/errors/index'

type ZodObjectType = z.ZodObject<z.ZodRawShape>

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>

export type ToolInput<T extends ZodObjectType = ZodObjectType> = {
  name: string
  description: string
  parameters: T
  handler?: ToolHandler
  /** Keep this tool's parameter schema out of the initial prompt; see `Tool.deferLoading`. */
  deferLoading?: boolean
  /** Heading this tool is listed under in the deferred catalog. */
  group?: string
}

// Zod's integer bounds; they add nothing a tool grammar needs.
const SAFE_INTEGER_BOUNDS = new Set([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])

function dropSafeIntegerBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(dropSafeIntegerBounds)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if ((key === 'minimum' || key === 'maximum') && SAFE_INTEGER_BOUNDS.has(value as number)) {
      continue
    }
    out[key] = dropSafeIntegerBounds(value)
  }
  return out
}

function zodToToolParameters(schema: ZodObjectType): Tool['parameters'] {
  const { $schema: _schema, ...json } = dropSafeIntegerBounds(
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
  ) as Record<string, unknown>
  return { ...json, type: 'object', properties: json['properties'] ?? {} } as Tool['parameters']
}

export function convertToolInput(input: ToolInput): Tool {
  const tool: Tool = {
    type: 'function',
    name: input.name,
    description: input.description,
    ...(input.deferLoading !== undefined && { deferLoading: input.deferLoading }),
    ...(input.group !== undefined && { group: input.group }),
    parameters: zodToToolParameters(input.parameters)
  }

  return toolSchema.parse(tool)
}

export function convertTools(inputs: ToolInput[]): Tool[] {
  return inputs.map(convertToolInput)
}

/**
 * Validates and converts tools from either ToolInput (with Zod schemas) or full Tool format.
 * Returns validated Tool[] array.
 */
export type ToolHandlerMap = Map<string, ToolHandler>

export type ValidateToolsResult = {
  tools: Tool[]
  handlers: ToolHandlerMap
}

export function validateTools(tools: Tool[] | ToolInput[]): ValidateToolsResult {
  if (tools.length === 0) {
    return { tools: [], handlers: new Map() }
  }

  const firstTool = tools[0]
  if (!firstTool) {
    throw new InvalidToolsArrayError()
  }

  const handlers: ToolHandlerMap = new Map()

  const parseResult = toolSchema.safeParse(firstTool)

  if (parseResult.success) {
    const validatedTools: Tool[] = []
    for (const tool of tools as Tool[]) {
      const result = toolSchema.safeParse(tool)
      if (!result.success) {
        throw new InvalidToolSchemaError(result.error.message, result.error)
      }
      validatedTools.push(result.data)
    }
    return { tools: validatedTools, handlers }
  } else {
    const toolInputs = tools as ToolInput[]
    const convertedTools = convertTools(toolInputs)

    for (const toolInput of toolInputs) {
      if (toolInput.handler) {
        handlers.set(toolInput.name, toolInput.handler)
      }
    }

    return { tools: convertedTools, handlers }
  }
}

export function attachHandlersToToolCalls(
  toolCalls: ToolCall[],
  handlers: ToolHandlerMap
): ToolCallWithCall[] {
  return toolCalls.map((toolCall) => {
    const handler = handlers.get(toolCall.name)
    if (handler) {
      return {
        ...toolCall,
        invoke: async () => await handler(toolCall.arguments)
      }
    }
    return toolCall
  })
}
