import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadModelConstants } from '@/serve/sdk-constants'
import { buildBuiltinCatalog } from '@/serve/core/model-catalog'
import {
  DEFAULT_STARTER,
  MODALITIES,
  TTS_VOICE_PLACEHOLDER,
  buildAdditions,
  type AddedEntry,
  type Modality
} from '@/configure/presets'
import { CONFIG_DOCS_URL, docsUrlForAddon } from '@/configure/docs-links'
import {
  existingAliasesByModel,
  existingModelIdentities,
  foreignConfigPath,
  loadJsonConfig,
  mergeServeModels,
  writeConfigAtomically
} from '@/configure/write-config'

export interface ConfigureOptions {
  projectRoot?: string
  config?: string | undefined
  yes?: boolean | undefined
  modality?: string[] | undefined
  force?: boolean | undefined
  quiet?: boolean | undefined
}

const VALID_MODALITIES = new Set<string>(MODALITIES.map((m) => m.id))

function resolveModalities(input: string[] | undefined): Modality[] {
  if (!input || input.length === 0) return DEFAULT_STARTER
  return input.map((raw) => {
    const m = raw.trim().toLowerCase()
    if (!VALID_MODALITIES.has(m)) {
      throw new Error(`Unknown modality "${raw}". Valid: ${[...VALID_MODALITIES].join(', ')}`)
    }
    return m as Modality
  })
}

export async function runConfigure(options: ConfigureOptions): Promise<void> {
  const projectRoot = options.projectRoot ?? process.cwd()
  const targetPath = options.config
    ? resolve(projectRoot, options.config)
    : join(projectRoot, 'qvac.config.json')
  const print = (msg = ''): void => {
    if (!options.quiet) process.stdout.write(`${msg}\n`)
  }

  if (!targetPath.endsWith('.json')) {
    throw new Error('configure writes JSON only — target a qvac.config.json path.')
  }

  // A non-JSON config already owns this project — don't create a competing .json.
  if (!existsSync(targetPath)) {
    const foreign = foreignConfigPath(projectRoot)
    if (foreign) {
      print(`Found ${foreign}, which configure can't rewrite safely.`)
      print(`Add models to its serve.models by hand — see ${CONFIG_DOCS_URL}`)
      return
    }
  }

  const nonInteractive = options.yes === true || (options.modality?.length ?? 0) > 0
  if (!nonInteractive && process.stdin.isTTY !== true) {
    throw new Error('configure is interactive; run it in a terminal, or pass --yes / --modality.')
  }

  const existing = loadJsonConfig(targetPath)
  const existingAliases = new Set(Object.keys(existing.serve?.models ?? {}))

  let additions: AddedEntry[]
  if (nonInteractive) {
    const selections = resolveModalities(options.modality).map((modality) => ({ modality }))
    additions = buildAdditions(selections, new Set(existingAliases))
  } else {
    const { runInteractive } = await import('@/configure/prompts')
    const catalog = buildBuiltinCatalog(loadModelConstants())
    try {
      additions = await runInteractive(catalog, existingAliases, process.stdout.isTTY === true)
    } catch (err) {
      // Ctrl+C in a prompt throws ExitPromptError — treat it as a clean abort:
      // "Done" is the only path that writes, so nothing is persisted here.
      if (err instanceof Error && err.name === 'ExitPromptError') {
        print('\nCancelled — nothing written.')
        return
      }
      throw err
    }
  }

  if (additions.length === 0) {
    print('Nothing to add.')
    return
  }

  // Idempotent per model: skip a constant that's already configured. With
  // --force, re-add it — overwriting the existing alias in place rather than
  // minting a deduped `<alias>-2` (aliasFor already uniqued against existing).
  const configuredIds = existingModelIdentities(existing)
  const aliasByModel = options.force === true ? existingAliasesByModel(existing) : null
  const fresh: AddedEntry[] = []
  const alreadyConfigured: string[] = []
  for (const a of additions) {
    const id = a.entry.model ?? a.entry.src
    if (id !== undefined && configuredIds.has(id)) {
      if (options.force !== true) {
        alreadyConfigured.push(id)
        continue
      }
      const existingAlias = aliasByModel?.get(id)
      if (existingAlias) a.alias = existingAlias
    }
    fresh.push(a)
  }

  if (fresh.length === 0) {
    print(
      alreadyConfigured.length
        ? `Already configured: ${alreadyConfigured.join(', ')} (use --force to re-add).`
        : 'No changes.'
    )
    return
  }

  const additionsMap = Object.fromEntries(fresh.map((a) => [a.alias, a.entry]))
  const { config, added } = mergeServeModels(existing, additionsMap, options.force === true)

  writeConfigAtomically(targetPath, config)

  const total = Object.keys(config.serve?.models ?? {}).length
  const quote = (a: string): string => `"${a}"`
  const updated = added.filter((a) => existingAliases.has(a))
  const newlyAdded = added.filter((a) => !existingAliases.has(a))
  const parts: string[] = []
  if (newlyAdded.length) parts.push(`added ${newlyAdded.map(quote).join(', ')}`)
  if (updated.length) parts.push(`updated ${updated.map(quote).join(', ')}`)
  print(`\n✅ ${parts.join('; ')} — ${targetPath} now has ${total} model${total === 1 ? '' : 's'}.`)
  if (alreadyConfigured.length) {
    print(`   Already configured (skipped): ${alreadyConfigured.join(', ')}`)
  }
  for (const a of fresh) {
    if (JSON.stringify(a.entry).includes(TTS_VOICE_PLACEHOLDER)) {
      print(
        `   • ${a.alias}: set config.referenceAudioSrc to a real .wav — ${docsUrlForAddon(a.addon)}`
      )
    }
  }
  print('\n   Run:  qvac serve openai')
  print(`   Docs: ${CONFIG_DOCS_URL}`)
}
