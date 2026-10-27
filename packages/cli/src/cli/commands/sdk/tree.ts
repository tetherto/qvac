import { command, flag, summary, bail } from 'paparam'
import type { Command } from 'paparam'
import { SDK, type SdkDefinition } from './definitions.js'

export interface SdkCommand extends Command {
  sdk: SdkDefinition
}

export function sdkTree(definition: SdkDefinition = SDK): SdkCommand {
  const options = definition.options.map((option) => {
    const match = option.spec.match(/(--[\w-]+)(.*)$/)
    if (!match) throw new Error(`Invalid SDK flag: ${option.spec}`)
    const short = option.spec.match(/(?:^|\s)(-\w),/)
    const spec = match[1]! + (short ? `|${short[1]}` : '') + match[2]!
    const result = flag(spec, option.description)
    if (option.multiple) result.multiple()
    if (option.default !== undefined) result.default(option.default)
    return result
  })
  return Object.assign(
    command(
      definition.name,
      summary(definition.description),
      ...options,
      ...definition.children.map((child) => sdkTree(child)),
      bail((reason) => {
        throw new Error(
          `${reason.reason}: ${reason.flag?.name ?? reason.arg?.value ?? reason.command.name}`
        )
      })
    ),
    { sdk: definition }
  )
}

export function sdkOptions(leaf: SdkCommand): Record<string, unknown> {
  const chain: SdkCommand[] = []
  for (let node: Command | null = leaf; node; node = node.parent) chain.unshift(node as SdkCommand)
  const options: Record<string, unknown> = {}
  // Defaults first, explicit flags second: parent options survive alias defaults.
  for (const node of chain) Object.assign(options, node.flags)
  for (const node of chain) {
    for (const key of Object.keys(node.indices.flags)) options[key] = node.flags[key]
  }
  for (const node of chain) {
    for (const option of node.sdk.options) {
      const name = option.spec
        .match(/--([\w-]+)/)![1]!
        .replace(/^no-/, '')
        .replace(/-(.)/g, (_, c: string) => c.toUpperCase())
      if (option.required && options[name] === undefined) {
        throw new Error(`missing required option ${option.spec}`)
      }
    }
  }
  return options
}
