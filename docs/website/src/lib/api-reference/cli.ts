/**
 * The reference data of a command-line product and of its HTTP API, as the
 * CLI generator writes them (`_generated/cli.json`, `_generated/openapi.json`),
 * and their Markdown renditions for a page's Markdown twin.
 */
import { shapeAsTypeScript } from './card'
import { SchemaReader, type JsonSchema } from './schema'

export interface CliOption {
  flags: string
  description: string
  default: unknown
  choices: string[] | null
  required: boolean
  env: string | null
}

export interface CliArgument {
  name: string
  description: string
  required: boolean
  variadic: boolean
  default: unknown
  choices: string[] | null
}

export interface CliCommand {
  name: string
  path: string
  description: string
  aliases: string[]
  arguments: CliArgument[]
  options: CliOption[]
  commands: CliCommand[]
}

export interface CliData {
  name: string
  description: string
  options: CliOption[]
  commands: CliCommand[]
}

export interface OpenApiOperation {
  method: string
  path: string
  summary?: string
  description?: string
  request: JsonSchema | null
  responses: { status: string; description?: string; schema: JsonSchema | null }[]
}

/** Every command of the tree, depth first, or the subtree under `path`. */
export function commandsOf(data: CliData, path?: string): CliCommand[] {
  const flat: CliCommand[] = []
  const walk = (commands: CliCommand[]) => {
    for (const command of commands) {
      flat.push(command)
      walk(command.commands)
    }
  }
  walk(data.commands)
  return path ? flat.filter((command) => command.path === path || command.path.startsWith(`${path} `)) : flat
}

export function usage(command: CliCommand): string {
  const args = command.arguments.map((argument) => {
    const name = `${argument.name}${argument.variadic ? '...' : ''}`
    return argument.required ? `<${name}>` : `[${name}]`
  })
  const tail = [command.options.length > 0 ? '[options]' : '', command.commands.length > 0 ? '[command]' : '']
  return [command.path, ...args, ...tail].filter(Boolean).join(' ')
}

function optionNotes(option: CliOption): string {
  const notes: string[] = []
  if (option.required) notes.push('required')
  if (option.default !== null && option.default !== undefined) notes.push(`default ${JSON.stringify(option.default)}`)
  if (option.choices) notes.push(`one of ${option.choices.map((choice) => `\`${choice}\``).join(', ')}`)
  if (option.env) notes.push(`env \`${option.env}\``)
  return notes.join('; ')
}

export function commandAsMarkdown(command: CliCommand, tablesOnly = false): string {
  const sections = tablesOnly
    ? [`\`\`\`\n${usage(command)}\n\`\`\``]
    : [`### \`${command.path}\``, command.description, `\`\`\`\n${usage(command)}\n\`\`\``]
  if (command.arguments.length > 0) {
    sections.push(
      command.arguments
        .map((argument) => `- \`${argument.name}\`${argument.required ? '' : ' (optional)'}: ${argument.description}`)
        .join('\n'),
    )
  }
  if (command.options.length > 0) {
    sections.push(
      command.options
        .map((option) => {
          const notes = optionNotes(option)
          return `- \`${option.flags}\`: ${option.description}${notes ? ` (${notes})` : ''}`
        })
        .join('\n'),
    )
  }
  return sections.filter(Boolean).join('\n\n')
}

export function cliAsMarkdown(data: CliData, path?: string, tablesOnly = false): string {
  const commands = tablesOnly && path ? commandsOf(data, path).filter((command) => command.path === path) : commandsOf(data, path)
  return commands.map((command) => commandAsMarkdown(command, tablesOnly)).join('\n\n')
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete']

/** The operations of an OpenAPI document, with `$ref`s left for the reader. */
export function openApiOperations(document: Record<string, unknown>): { reader: SchemaReader; operations: OpenApiOperation[] } {
  const components = (document.components as { schemas?: Record<string, JsonSchema> } | undefined)?.schemas ?? {}
  const reader = new SchemaReader({ $defs: components })
  const operations: OpenApiOperation[] = []
  for (const [route, item] of Object.entries((document.paths as Record<string, Record<string, unknown>>) ?? {})) {
    for (const method of METHODS) {
      const operation = item[method] as Record<string, unknown> | undefined
      if (!operation) continue
      const body = operation.requestBody as { content?: Record<string, { schema?: JsonSchema }> } | undefined
      const request = body?.content ? Object.values(body.content)[0]?.schema ?? null : null
      const responses = Object.entries((operation.responses as Record<string, Record<string, unknown>>) ?? {}).map(
        ([status, response]) => {
          const content = response.content as Record<string, { schema?: JsonSchema }> | undefined
          return {
            status,
            description: response.description as string | undefined,
            schema: content ? Object.values(content)[0]?.schema ?? null : null,
          }
        },
      )
      operations.push({
        method: method.toUpperCase(),
        path: route,
        summary: operation.summary as string | undefined,
        description: operation.description as string | undefined,
        request,
        responses,
      })
    }
  }
  return { reader, operations }
}

export function openApiAsMarkdown(document: Record<string, unknown>): string {
  const { reader, operations } = openApiOperations(document)
  return operations
    .map((operation) => {
      const parts = [`### \`${operation.method} ${operation.path}\``]
      if (operation.summary) parts.push(operation.summary)
      if (operation.description && operation.description !== operation.summary) parts.push(operation.description)
      const request = operation.request ? reader.shapeOf(operation.request) : null
      if (request) parts.push(`Request body:\n\n\`\`\`ts\n${shapeAsTypeScript(request)}\n\`\`\``)
      const statuses = operation.responses.map((response) => `\`${response.status}\`${response.description ? ` ${response.description}` : ''}`)
      if (statuses.length > 0) parts.push(`Responses: ${statuses.join(' · ')}`)
      return parts.join('\n\n')
    })
    .join('\n\n')
}
