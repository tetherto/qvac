declare module 'paparam' {
  export type FlagValue = string | boolean | string[] | undefined
  export interface Flag {
    name: string
    help: string
    description: string
    value: FlagValue
    default(value: FlagValue): Flag
    multiple(): Flag
    choices(values: string[]): Flag
  }
  export interface Argument {
    help: string
    value: string
  }
  export interface Bail {
    reason: string
    flag?: { name: string; long?: boolean; value?: string }
    arg?: Argument
    command: Command
  }
  export interface Command {
    name: string
    parent: Command | null
    flags: Record<string, FlagValue>
    positionals: string[]
    indices: { flags: Record<string, number>; args: Record<string, number> }
    _definedCommands: Map<string, Command>
    _definedArgs: Argument[]
    add(...parts: Part[]): Command
    parse(
      args: string[],
      options: { sync?: boolean; silent?: boolean; run?: boolean }
    ): Command | null
    help(...commands: string[]): string
    overview(): string
  }
  export interface Metadata {
    readonly kind?: 'metadata'
  }
  export type Part = Command | Flag | Argument | Metadata
  export function command(name: string, ...parts: Part[]): Command
  export function flag(spec: string, description?: string): Flag
  export function arg(spec: string, description?: string): Argument
  export function summary(text: string): Metadata
  export function header(text: string): Metadata
  export function footer(text: string): Metadata
  export function description(text: string | TemplateStringsArray, ...values: unknown[]): Metadata
  export function sloppy(options: { flags?: boolean; args?: boolean }): Metadata
  export function bail(handler: (reason: Bail) => never): Metadata
}
