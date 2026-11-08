#!/usr/bin/env bun
/**
 * Print a Commander CLI's command tree, and optionally its OpenAPI document,
 * as JSON. Run with the CLI package as the working directory, so its path
 * aliases and dependencies resolve:
 *
 *   bun run <this file> <entry> [<openapi module>#<export>]
 *
 * The entry is read, never executed — executing it would parse
 * `process.argv`. Its `import { registerX } from '…'` lines and its
 * `.name()` / `.description()` / `.version()` calls are what this replays:
 * each register function is imported and applied to a fresh `Command`.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

interface CommanderOption {
  flags: string
  long?: string
  short?: string
  description: string
  defaultValue?: unknown
  argChoices?: string[]
  mandatory?: boolean
  envVar?: string
  negate?: boolean
  hidden?: boolean
}

interface CommanderArgument {
  name(): string
  description: string
  required: boolean
  variadic: boolean
  defaultValue?: unknown
  argChoices?: string[]
}

interface CommanderCommand {
  name(value?: string): string
  description(value?: string): string
  aliases(): string[]
  options: CommanderOption[]
  registeredArguments?: CommanderArgument[]
  commands: CommanderCommand[]
  _hidden?: boolean
}

function serializeOption(option: CommanderOption) {
  return {
    flags: option.flags,
    long: option.long ?? null,
    short: option.short ?? null,
    description: option.description,
    default: option.defaultValue === undefined ? null : option.defaultValue,
    choices: option.argChoices ?? null,
    required: Boolean(option.mandatory),
    env: option.envVar ?? null,
  }
}

function serializeCommand(command: CommanderCommand, parents: string[]): unknown {
  const commandPath = [...parents, command.name()]
  return {
    name: command.name(),
    path: commandPath.join(' '),
    description: command.description(),
    aliases: command.aliases(),
    arguments: (command.registeredArguments ?? []).map((argument) => ({
      name: argument.name(),
      description: argument.description,
      required: argument.required,
      variadic: argument.variadic,
      default: argument.defaultValue === undefined ? null : argument.defaultValue,
      choices: argument.argChoices ?? null,
    })),
    options: command.options.filter((option) => !option.hidden).map(serializeOption),
    commands: command.commands
      .filter((child) => !child._hidden)
      .map((child) => serializeCommand(child, commandPath)),
  }
}

const [entryArg, openapiArg] = process.argv.slice(2)
const entry = path.resolve(entryArg)
const source = readFileSync(entry, 'utf-8')
const { Command } = (await import('commander')) as unknown as { Command: new () => CommanderCommand }
const program = new Command() as CommanderCommand & {
  name(value?: string): string
  description(value?: string): string
}

const literal = (method: string) => new RegExp(`\\.${method}\\(\\s*['"\`]([^'"\`]+)['"\`]`).exec(source)?.[1]
const name = literal('name')
const description = literal('description')
if (name) program.name(name)
if (description) program.description(description)

/**
 * Maps a specifier through the CLI package's own `tsconfig.json` paths. The
 * modules the entry imports resolve their own aliases from their package, but
 * a specifier imported here would resolve against this file's location.
 */
function resolveAlias(specifier: string): string {
  let config: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } = {}
  try {
    config = JSON.parse(readFileSync('tsconfig.json', 'utf-8').replace(/^\s*\/\/.*$/gm, ''))
  } catch {
    return specifier
  }
  const base = path.resolve(config.compilerOptions?.baseUrl ?? '.')
  for (const [pattern, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
    const prefix = pattern.replace(/\*$/, '')
    if (pattern.endsWith('*') ? specifier.startsWith(prefix) : specifier === pattern) {
      return path.resolve(base, targets[0].replace(/\*$/, specifier.slice(prefix.length)))
    }
  }
  return specifier
}

const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)]
const registrations = [...source.matchAll(/(register\w+)\(\s*program\s*\)/g)].map((match) => match[1])
for (const registration of registrations) {
  const found = imports.find(([, names]) => names.split(',').map((entry) => entry.trim()).includes(registration))
  if (!found) throw new Error(`${registration} is called by ${entryArg} but not imported by name`)
  const specifier = found[2].startsWith('.') ? path.resolve(path.dirname(entry), found[2]) : resolveAlias(found[2])
  const module = (await import(specifier)) as Record<string, (program: unknown) => void>
  module[registration](program)
}

let openapi: unknown = null
if (openapiArg) {
  const [modulePath, exportName] = openapiArg.split('#')
  const module = (await import(path.resolve(modulePath))) as Record<string, (format: string) => Promise<string>>
  openapi = JSON.parse(await module[exportName]('json'))
}

console.log(
  JSON.stringify({
    cli: {
      name: program.name(),
      description: program.description(),
      options: program.options.filter((option) => !option.hidden).map(serializeOption),
      commands: program.commands.filter((child) => !child._hidden).map((child) => serializeCommand(child, [program.name()])),
    },
    openapi,
  }),
)
