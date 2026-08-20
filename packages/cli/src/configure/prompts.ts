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
  type BuiltEntry,
  type Modality,
  type ServeModelEntry
} from './presets.js'
import { docsUrlForAddon } from './docs-links.js'

// Sentinel a picker returns when the user chooses "Back". The delimiters can't
// occur in a model constant id or a modality value, so it never collides.
const BACK = '::back::'

function fmtSize(bytes: number | null): string {
  if (bytes === null) return ''
  const mb = bytes / 1_000_000
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

function fmtRow(e: ModelCatalogEntry): string {
  const meta = [e.params, e.quantization, fmtSize(e.size)].filter(Boolean).join(' - ')
  return meta ? `${e.id}   ${meta}` : e.id
}

// Match a search term against the fields a user reaches for - not just the id,
// but role/addon/engine/quantization/params - so "diffusion" or "q8" finds
// models by capability, not only by name. Space-separated words must all match.
function matches(e: ModelCatalogEntry, term: string): boolean {
  const haystack = [e.id, e.role, e.addon, e.engine, e.quantization, e.params]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return term.split(/\s+/).every((word) => haystack.includes(word))
}

// Returns a chosen constant id, or BACK if the user backs out.
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
      const list = t ? ordered.filter((e) => matches(e, t)) : ordered
      const choices = list.slice(0, 40).map((e) => ({
        name: e.id === recommended ? `${fmtRow(e)}  * recommended` : fmtRow(e),
        value: e.id,
        description: docsUrlForAddon(e.addon)
      }))
      return [
        ...choices,
        { name: '<- Back', value: BACK, description: 'Return to the previous menu' }
      ]
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

// Preview the entry, then Add / Edit / Back. After an edit the preview re-renders
// with the edited result, so the user sees the final entry before adding.
// Returns the confirmed addition, or BACK to return to the previous step.
async function confirmEntry(
  built: BuiltEntry,
  taken: Set<string>,
  canEdit: boolean
): Promise<AddedEntry | typeof BACK> {
  const alias = aliasFor(built.aliasBase, taken)
  let entry = built.entry
  for (;;) {
    const proceed = await select<string>({
      message: `${previewText(alias, entry, built.addon)}Proceed?`,
      choices: [
        { name: `Add it (alias: ${alias})`, value: 'add' },
        ...(canEdit ? [{ name: 'Edit in $EDITOR...', value: 'edit' }] : []),
        { name: '<- Back', value: 'back' }
      ]
    })
    if (proceed === 'back') return BACK
    if (proceed === 'edit') {
      entry = await editEntry(alias, entry)
      continue
    }
    taken.add(alias)
    return { alias, addon: built.addon, entry }
  }
}

async function addByCapability(
  catalog: ModelCatalogEntry[],
  taken: Set<string>,
  canEdit: boolean
): Promise<AddedEntry | typeof BACK> {
  for (;;) {
    const modality = await select<Modality | typeof BACK>({
      message: 'Capability?',
      choices: [
        ...MODALITIES.map((m) => ({ name: m.label, value: m.id })),
        { name: '<- Back', value: BACK }
      ]
    })
    if (modality === BACK) return BACK

    const info = modalityInfo(modality)
    let constantName: string | undefined
    if (info.pick) {
      const pool = catalog.filter((e) => e.role === info.role)
      const picked = await pickModel(
        pool,
        `Pick a ${info.label} model (type to search)`,
        RECOMMENDED[modality]
      )
      if (picked === BACK) continue
      constantName = picked
    }

    const res = await confirmEntry(buildEntry(modality, constantName), taken, canEdit)
    if (res === BACK) continue
    return res
  }
}

async function addBySearch(
  catalog: ModelCatalogEntry[],
  taken: Set<string>,
  canEdit: boolean
): Promise<AddedEntry | typeof BACK> {
  for (;;) {
    const picked = await pickModel(catalog, 'Search all models (type to search)')
    if (picked === BACK) return BACK
    const found = catalog.find((e) => e.id === picked)
    const res = await confirmEntry(buildGenericEntry(picked, found?.addon ?? null), taken, canEdit)
    if (res === BACK) continue
    return res
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
      message: added.length ? `What next? (${added.length} queued)` : 'What do you want to do?',
      choices: [
        { name: 'Add a model by capability', value: 'capability' },
        { name: 'Search all models', value: 'search' },
        { name: added.length ? 'Done - write config' : 'Done', value: 'done' }
      ]
    })
    if (action === 'done') break

    const res =
      action === 'capability'
        ? await addByCapability(catalog, taken, canEdit)
        : await addBySearch(catalog, taken, canEdit)
    if (res === BACK) continue

    added.push(res)
    process.stdout.write(`  + queued "${res.alias}"${res.addon ? ` (${res.addon})` : ''}\n`)
  }

  return added
}
