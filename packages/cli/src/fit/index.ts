import { close } from '@qvac/sdk'
import { findConfigFile, loadConfig } from '@/config'
import { parseServeConfig } from '@/serve/core/config'
import type { ServeConfig } from '@/serve/core/config/types'
import { assessNamedModels, fitModelType } from '@/serve/core/fit'
import { assessCatalog, catalogModels } from '@/fit/catalog'
import { formatCatalog, formatFit } from '@/fit/format'
import { parseSettings, settingsFor, type FitSettings } from '@/fit/settings'

export interface FitOptions {
  projectRoot: string
  config?: string | undefined
  models: string[]
  set: string[]
  json?: boolean | undefined
  catalog?: boolean | undefined
}

/** `0` fits, `2` does not fit, `3` unknown. An error throws instead. */
export const FIT_EXIT_CODES = { fits: 0, 'does-not-fit': 2, unknown: 3 } as const

export class FitUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FitUsageError'
  }
}

/**
 * Runs `qvac fit`: judges the named models loaded together, or with
 * `catalog`, every SDK model constant on its own. Prints the answer and
 * returns the exit code. The SDK worker is closed before it returns.
 *
 * @throws {FitUsageError} When the arguments name no model, or `--set` names a
 *   model that is not being assessed.
 */
export async function runFit(options: FitOptions): Promise<number> {
  if (options.catalog === true && options.models.length > 0) {
    throw new FitUsageError('--catalog judges every SDK model; name no models with it.')
  }
  if (options.catalog !== true && options.models.length === 0) {
    throw new FitUsageError('Name at least one model, or pass --catalog.')
  }

  const settings = parseSettings(options.set)
  const serveConfig =
    options.catalog === true ? parseServeConfig({}, {}) : await loadServeConfig(options)
  const assessed = options.catalog === true ? catalogModels() : options.models
  const types = new Set(assessed.map((model) => fitModelType(serveConfig, model)))
  for (const target of settings.byTarget.keys()) {
    if (!assessed.includes(target) && !types.has(target)) {
      throw new FitUsageError(
        `--set names "${target}", which is neither a model being assessed nor the type of one.`
      )
    }
  }

  try {
    return options.catalog === true
      ? await printCatalog(settings, options.json === true)
      : await printFit(serveConfig, settings, options)
  } finally {
    await close()
  }
}

async function printFit(
  serveConfig: ServeConfig,
  settings: FitSettings,
  options: FitOptions
): Promise<number> {
  const result = await assessNamedModels(
    serveConfig,
    options.models.map((model) => ({
      model,
      modelConfig: settingsFor(settings, model, fitModelType(serveConfig, model))
    }))
  )
  console.log(options.json === true ? JSON.stringify(result, null, 2) : formatFit(result))
  return FIT_EXIT_CODES[result.verdict]
}

async function printCatalog(settings: FitSettings, json: boolean): Promise<number> {
  const progress = process.stderr.isTTY
    ? (done: number, total: number, model: string) =>
        process.stderr.write(`\r\x1b[K[${done}/${total}] ${model}`)
    : undefined
  const report = await assessCatalog(settings, progress)
  if (progress !== undefined) process.stderr.write('\r\x1b[K')
  console.log(json ? JSON.stringify(report, null, 2) : formatCatalog(report))
  return FIT_EXIT_CODES.fits
}

// Aliases come from `serve.models`, found the way `qvac serve` finds it. No
// config file is needed to assess SDK model constants, and catalog mode reads none.
async function loadServeConfig(options: FitOptions): Promise<ServeConfig> {
  const configPath = findConfigFile(options.projectRoot, options.config)
  if (configPath === null) return parseServeConfig({}, {})
  const raw = (await loadConfig(configPath)) as Parameters<typeof parseServeConfig>[0]
  return parseServeConfig(raw, {})
}
