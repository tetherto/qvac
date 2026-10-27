#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import pkg from '../../package.json' with { type: 'json' }
import { sdkTree, sdkOptions, type SdkCommand } from './commands/sdk/tree.js'

async function main(words: string[]): Promise<void> {
  if (words.length === 1 && ['--version', '-V'].includes(words[0]!)) {
    console.log(pkg.version)
    return
  }
  const leaf = sdkTree().parse(words, { sync: true, run: false }) as SdkCommand | null
  if (!leaf) return
  if (!leaf.sdk.action) {
    console.log(leaf.help())
    return
  }
  const options = sdkOptions(leaf)
  switch (leaf.sdk.action) {
    case 'bundle_sdk_0': {
      const { handler0 } = await import('./commands/sdk/bundle-sdk/command.js')
      await handler0(options as Parameters<typeof handler0>[0])
      break
    }
    case 'configure_0': {
      const { handler0 } = await import('./commands/sdk/configure/command.js')
      await handler0(options as Parameters<typeof handler0>[0])
      break
    }
    case 'doctor_0': {
      const { handler0 } = await import('./commands/sdk/doctor/command.js')
      await handler0(options as Parameters<typeof handler0>[0])
      break
    }
    case 'openai_0': {
      const { handler0 } = await import('./commands/sdk/openai/command.js')
      await handler0(options as Parameters<typeof handler0>[0])
      break
    }
    case 'openai_1': {
      const { handler1 } = await import('./commands/sdk/openai/command.js')
      await handler1(options as Parameters<typeof handler1>[0])
      break
    }
    case 'serve_0': {
      const { handler0 } = await import('./commands/sdk/serve/command.js')
      await handler0(options as Parameters<typeof handler0>[0])
      break
    }
    case 'serve_1': {
      const { handler1 } = await import('./commands/sdk/serve/command.js')
      await handler1(options as Parameters<typeof handler1>[0])
      break
    }
    case 'verify_0': {
      const { handler0 } = await import('./commands/sdk/verify/command.js')
      await handler0(options as Parameters<typeof handler0>[0])
      break
    }
    case 'verify_1': {
      const { handler1 } = await import('./commands/sdk/verify/command.js')
      await handler1(options as Parameters<typeof handler1>[0])
      break
    }
    default:
      throw new Error(`Unknown SDK action ${leaf.sdk.action}`)
  }
}
export async function runSdkCommand(words: string[]): Promise<void> {
  await main(words).catch((error: unknown) => {
    console.error(`qvac sdk: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = words[0] === 'verify' && words[1] === 'deps' ? 2 : 1
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runSdkCommand(process.argv.slice(2))
