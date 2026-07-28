import fs from 'fs'
import { generateExportName } from './naming'
import type { CurrentModel, ProcessedModel } from './types'
import { getCommitHash } from './utils'

// Splits the body of the generated `models` array into one string per
// top-level entry. Brace-depth scanning (rather than a `[^}]+` regex) is
// required because entries carrying `shardMetadata` / `companionSet` contain
// nested objects, and quote tracking keeps braces inside string literals from
// throwing the depth off.
export function extractEntryBlocks(arrayContent: string): string[] {
  const entries: string[] = []
  let depth = 0
  let start = -1
  let quote: string | null = null

  for (let i = 0; i < arrayContent.length; i++) {
    const char = arrayContent[i]

    if (quote !== null) {
      if (char === '\\') i++
      else if (char === quote) quote = null
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === '{') {
      if (depth === 0) start = i
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        entries.push(arrayContent.slice(start, i + 1))
        start = -1
      }
    }
  }

  return entries
}

// Reads the first `<field>: '<value>'` pair out of an entry block. Accepts
// either quote style because codegen emits double quotes and Prettier then
// rewrites them to single quotes, and tolerates the line break Prettier
// inserts after the colon on long values.
function readStringField(entry: string, field: string): string | null {
  const match = new RegExp(`\\b${field}:\\s*(?:'([^']*)'|"([^"]*)")`).exec(entry)
  if (!match) return null
  return match[1] ?? match[2] ?? null
}

export function loadCurrentModels(outputFile: string): CurrentModel[] {
  try {
    if (!fs.existsSync(outputFile)) {
      return []
    }

    const content = fs.readFileSync(outputFile, 'utf-8')
    const modelsMatch = content.match(/export const models = \[([\s\S]*?)\n\] as const/)

    if (!modelsMatch?.[1]) {
      console.warn(`⚠️  Could not locate the models array in ${outputFile}`)
      return []
    }

    const currentModels: CurrentModel[] = []

    // `name` and `registryPath` are emitted as the first two fields of every
    // entry, so the first match in a block always belongs to the model itself
    // and never to a nested companion file.
    for (const entry of extractEntryBlocks(modelsMatch[1])) {
      const name = readStringField(entry, 'name')
      const registryPath = readStringField(entry, 'registryPath')
      if (name && registryPath) {
        currentModels.push({ name, registryPath })
      }
    }

    if (currentModels.length === 0) {
      // Silently returning an empty list makes every remote model look new and
      // hides removals entirely, so surface it instead of reporting bogus drift.
      console.warn(`⚠️  Parsed 0 models from ${outputFile} — drift comparison is unreliable`)
    }

    return currentModels
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.warn('⚠️  Could not load current models:', message)
    return []
  }
}

export function compareModels(
  remoteModels: ProcessedModel[],
  currentModels: CurrentModel[]
): { added: ProcessedModel[]; removed: CurrentModel[] } {
  const currentPaths = new Set(currentModels.map((m) => m.registryPath))
  const remotePaths = new Set(remoteModels.map((m) => m.registryPath))

  const added = remoteModels.filter((m) => !currentPaths.has(m.registryPath))
  const removed = currentModels.filter((m) => !remotePaths.has(m.registryPath))

  return { added, removed }
}

export function assignNames(models: ProcessedModel[]): (ProcessedModel & { name: string })[] {
  const usedNames = new Set<string>()
  return models.map((m) => ({
    ...m,
    name: generateExportName({
      path: m.registryPath,
      engine: m.engine,
      name: m.modelName,
      quantization: m.quantization,
      params: m.params,
      tags: m.tags,
      usedNames
    })
  }))
}

export function separateUpdates(
  added: (ProcessedModel & { name: string })[],
  removed: CurrentModel[]
): {
  added: (ProcessedModel & { name: string })[]
  updated: (ProcessedModel & { name: string })[]
  removed: CurrentModel[]
} {
  const removedNames = new Set(removed.map((m) => m.name))
  const addedNames = new Set(added.map((m) => m.name))
  const updatedNames = new Set([...addedNames].filter((name) => removedNames.has(name)))

  return {
    added: added.filter((m) => !updatedNames.has(m.name)),
    updated: added.filter((m) => updatedNames.has(m.name)),
    removed: removed.filter((m) => !updatedNames.has(m.name))
  }
}

export function createHistoryFile(
  added: (ProcessedModel & { name: string })[],
  removed: CurrentModel[],
  currentModels: CurrentModel[],
  historyDir: string
): string | null {
  if (added.length === 0 && removed.length === 0) {
    return null
  }

  const { added: trulyAdded, updated, removed: trulyRemoved } = separateUpdates(added, removed)

  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true })
  }

  const shortHash = getCommitHash(true)
  const fullHash = getCommitHash(false)
  const timestamp = new Date().toISOString()
  const filename = `${shortHash}.txt`
  const filepath = `${historyDir}/${filename}`

  let content = `commit=${fullHash}\n`
  content += `timestamp=${timestamp}\n`
  content += `previous_count=${currentModels.length}\n`
  content += `new_count=${currentModels.length + trulyAdded.length - trulyRemoved.length}\n`
  content += `\n`

  if (trulyAdded.length > 0) {
    content += `[added]\n`
    trulyAdded.forEach((m) => {
      content += `${m.name}\n`
    })
    content += `\n`
  }

  if (updated.length > 0) {
    content += `[updated]\n`
    updated.forEach((m) => {
      content += `${m.name}\n`
    })
    content += `\n`
  }

  if (trulyRemoved.length > 0) {
    content += `[removed]\n`
    trulyRemoved.forEach((m) => {
      content += `${m.name}\n`
    })
    content += `\n`
  }

  fs.writeFileSync(filepath, content)
  return filepath
}
