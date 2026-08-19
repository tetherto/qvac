import { select, search, editor, confirm } from '@inquirer/prompts'
import type { ModelCatalogEntry } from '../serve/core/model-catalog.js'
import { parseServeConfig } from '../serve/config.js'
import {
  MODALITIES,
  RECOMMENDED,
  aliasFor,
  buildEntry,
  buildGenericEntry,
  modalityInfo,
  type AddedEntry,
  type Modality,
  type ServeModelEntry
} from './presets.js'
import { docsUrlForAddon } from './docs-links.js'

function fmtSize(bytes: number | null): string {
  if (bytes === null) return ''
  const mb = bytes / 1_000_000
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

function fmtRow(e: ModelCatalogEntry): string {
  const meta = [e.params, e.quantization, fmtSize(e.size)].filter(Boolean).join(' · ')
  return meta ? `${e.id}   ${meta}` : e.id
}

function pickModel(
  pool: ModelCatalogEntry[],
  message: string,
  recommended?: string
): Promise<string> {
  const ordered = recommended
    ? [...pool].sort((a, b) => (a.id === recommended ? -1 : b.id === recommended ? 1 : 0))
    : pool
  return search<string>({
    message,
    source: (term) => {
      const t = term?.toLowerCase().trim()
      const list = t ? ordered.filter((e) => e.id.toLowerCase().includes(t)) : ordered
      return list.slice(0, 40).map((e) => ({
        name: e.id === recommended ? `${fmtRow(e)}  ★ recommended` : fmtRow(e),
        value: e.id,
        description: docsUrlForAddon(e.addon)
      }))
    }
  })
}

function previewText(alias: string, entry: ServeModelEntry, addon: string): string {
  const json = JSON.stringify({ [alias]: entry }, null, 2)
  return `\n${json}\n\n  Docs: ${docsUrlForAddon(addon)}\n`
}

// Open the entry's JSON in $EDITOR; re-open until it parses and validates.
async function editEntry(alias: string, entry: ServeModelEntry): Promise<ServeModelEntry> {
  let current = JSON.stringify(entry, null, 2)
  for (;;) {
    const edited = await editor({ message: `Edit "${alias}"`, default: current, postfix: '.json' })
    try {
      const parsed = JSON.parse(edited) as ServeModelEntry
      // Structural validation only; the entry shape is a valid serve.models value.
      parseServeConfig(
        { serve: { models: { [alias]: parsed } } } as Parameters<typeof parseServeConfig>[0],
        {}
      )
      return parsed
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const retry = await confirm({
        message: `Invalid entry (${message}). Edit again?`,
        default: true
      })
      if (!retry) return entry
      current = edited
    }
  }
}

/** Interactive menu loop. Returns the aliased additions the user confirmed. */
export async function runInteractive(
  catalog: ModelCatalogEntry[],
  existingAliases: Set<string>,
  canEdit: boolean
): Promise<AddedEntry[]> {
  const taken = new Set(existingAliases)
  const added: AddedEntry[] = []

  for (;;) {
    const action = await select<string>({
      message: 'What do you want to do?',
      choices: [
        { name: 'Add a model by capability', value: 'capability' },
        { name: 'Search all models', value: 'search' },
        { name: 'Done', value: 'done' }
      ]
    })
    if (action === 'done') break

    let aliasBase: string
    let entry: ServeModelEntry
    let addon: string

    if (action === 'capability') {
      const modality = await select<Modality>({
        message: 'Capability?',
        choices: MODALITIES.map((m) => ({ name: m.label, value: m.id }))
      })
      const info = modalityInfo(modality)
      let constantName: string | undefined
      if (info.pick) {
        const pool = catalog.filter((e) => e.role === info.role)
        constantName = await pickModel(
          pool,
          `Pick a ${info.label} model (type to search)`,
          RECOMMENDED[modality]
        )
      }
      const built = buildEntry(modality, constantName)
      aliasBase = built.aliasBase
      entry = built.entry
      addon = built.addon
    } else {
      const constantName = await pickModel(catalog, 'Search all models (type to search)')
      const picked = catalog.find((e) => e.id === constantName)
      const built = buildGenericEntry(constantName, picked?.addon ?? null)
      aliasBase = built.aliasBase
      entry = built.entry
      addon = built.addon
    }

    const alias = aliasFor(aliasBase, taken)
    const proceed = await select<string>({
      message: `${previewText(alias, entry, addon)}Proceed?`,
      choices: [
        { name: `Add it (alias: ${alias})`, value: 'add' },
        ...(canEdit ? [{ name: 'Edit before adding…', value: 'edit' }] : []),
        { name: 'Back', value: 'back' }
      ]
    })
    if (proceed === 'back') continue
    if (proceed === 'edit') entry = await editEntry(alias, entry)

    taken.add(alias)
    added.push({ alias, addon, entry })
  }

  return added
}
