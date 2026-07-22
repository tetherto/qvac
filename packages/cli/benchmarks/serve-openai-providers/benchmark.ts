#!/usr/bin/env npx tsx
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cmdCalibrate, cmdDigest, cmdFull, cmdPreflight, cmdReport, cmdSmoke } from './commands'
import { loadBenchmarkConfig, loadPrompts } from './config'

function printUsage(): void {
  console.log(`Usage: npx tsx benchmark.ts <command> [options]

Commands:
  digest                 SHA-256 the configured GGUF
  preflight              Parity + reasoning-off + usage checks
  smoke                  Preflight plus one short measured request per provider
  calibrate [--provider] Measure prompt_tokens for each prompt size
  full                   Full warmup + measured sweep
  report --raw <path> [--out <path>]
                         Rebuild report.md from a raw.json

Options:
  --config <path>        Path to benchmark.yaml (default: ./benchmark.yaml)
  --prompts <path>       Path to prompts.json (default: ./prompts.json)
`)
}

function takeFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) {
    return undefined
  }
  const value = args[idx + 1]
  args.splice(idx, 2)
  return value
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv]
  const configPath = takeFlag(args, '--config') ?? 'benchmark.yaml'
  const promptsPath = takeFlag(args, '--prompts') ?? 'prompts.json'
  const command = args.shift()
  if (!command || command === '-h' || command === '--help') {
    printUsage()
    return command ? 0 : 2
  }

  const root = process.cwd()
  const config = loadBenchmarkConfig(resolve(root, configPath))
  const promptsDoc = loadPrompts(resolve(root, promptsPath))

  switch (command) {
    case 'digest':
      return await cmdDigest(config)
    case 'preflight':
      return await cmdPreflight(config, promptsDoc)
    case 'smoke':
      return await cmdSmoke(config, promptsDoc)
    case 'calibrate': {
      const provider = takeFlag(args, '--provider') ?? 'qvac'
      return await cmdCalibrate(config, promptsDoc, provider)
    }
    case 'full':
      return await cmdFull(config, promptsDoc, root)
    case 'report': {
      const raw = takeFlag(args, '--raw')
      if (!raw) {
        console.error('report requires --raw <path>')
        return 2
      }
      const out = takeFlag(args, '--out') ?? 'results/report.md'
      return cmdReport(resolve(root, raw), resolve(root, out))
    }
    default:
      console.error(`unknown command: ${command}`)
      printUsage()
      return 2
  }
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exitCode = 1
    })
}
