import { emitKeypressEvents } from 'node:readline'
import { select, search, editor, confirm, input } from '@inquirer/prompts'
import type { ModelCatalogEntry } from '@/serve/core/model-catalog'
import { parseServeConfig } from '@/serve/config'
import {
  MODALITIES,
  RECOMMENDED,
  TTS_ENGINES,
  TTS_ENGINE_TEMPLATES,
  aliasFor,
  buildEntry,
  buildGenericEntry,
  modalityInfo,
  type AddedEntry,
  type BuiltEntry,
  type Modality,
  type ServeModelEntry
} from '@/configure/presets'
import { docsUrlForAddon } from '@/configure/docs-links'
import {
  configSchemaForAddon,
  configParamModel,
  coerceParam,
  validateParam,
  validateValue,
  type ConfigParamModel,
  type ParamField
} from '@/configure/param-schemas'

// Sentinel a prompt resolves to when the user backs out (Esc, or a "Back"
// choice). The delimiters can't occur in a model id or a modality value.
const BACK = '::back::'

// Run an @inquirer prompt with Esc bound to "go back one step": a keypress
// listener aborts the prompt's signal, which rejects with AbortPromptError;
// that is caught and surfaced as BACK. Ctrl+C still throws ExitPromptError and
// is handled one level up (a full abort, not a step back).
function askWithBack<T>(
  run: (ctx: { signal: AbortSignal }) => Promise<T>
): Promise<T | typeof BACK> {
  const controller = new AbortController()
  const stdin = process.stdin
  const onKeypress = (_str: string | undefined, key: { name?: string } | undefined): void => {
    if (key?.name === 'escape') controller.abort()
  }
  emitKeypressEvents(stdin)
  stdin.on('keypress', onKeypress)
  return run({ signal: controller.signal })
    .catch((err: unknown): typeof BACK => {
      if (err instanceof Error && err.name === 'AbortPromptError') return BACK
      throw err
    })
    .finally(() => {
      stdin.off('keypress', onKeypress)
    })
}

function fmtSize(bytes: number | null): string {
  if (bytes === null) return ''
  const mb = bytes / 1_000_000
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

function fmtRow(e: ModelCatalogEntry): string {
  const meta = [e.params, e.quantization, fmtSize(e.size)].filter(Boolean).join(' - ')
  return meta ? `${e.id}   ${meta}` : e.id
}

// Score a term against a model; 0 = no match. All words must appear somewhere in
// id/role/addon/quantization/params so "diffusion" or "q8" finds models by
// capability, not only by name. `engine` is deliberately excluded: its backend
// name (e.g. "llamacpp-completion") contains "llama"/"cpp" and would match every
// model of that backend, drowning out a name search. Matches in the id score
// higher, so typing "llama" surfaces the LLAMA_* models first.
function matchScore(e: ModelCatalogEntry, words: string[]): number {
  const id = e.id.toLowerCase()
  const haystack = [e.id, e.role, e.addon, e.quantization, e.params]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (!words.every((word) => haystack.includes(word))) return 0
  return 1 + words.filter((word) => id.includes(word)).length
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi))
}

interface PickOptions {
  recommended?: string | undefined
  // Builds the serve.models entry a given model would produce, so the picker can
  // preview it for the highlighted row (shown only when the terminal is wide).
  previewEntry?: ((id: string, addon: string | null) => ServeModelEntry) | undefined
}

// The @inquirer picker shows the highlighted choice's `description` below the
// list. On a wide terminal, show the concrete serve.models entry the model would
// produce (a real config example); otherwise just the docs link.
function describeChoice(
  e: ModelCatalogEntry,
  wide: boolean,
  previewEntry: PickOptions['previewEntry']
): string {
  const docs = `Docs: ${docsUrlForAddon(e.addon)}`
  if (!wide || !previewEntry) return docs
  const alias = aliasFor(e.id, new Set())
  const json = JSON.stringify({ [alias]: previewEntry(e.id, e.addon) }, null, 2)
  return `${json}\n\n${docs}`
}

// Returns a chosen constant id, or BACK if the user backs out (Esc / "Back").
function pickModel(
  pool: ModelCatalogEntry[],
  message: string,
  opts: PickOptions = {}
): Promise<string> {
  const { recommended, previewEntry } = opts
  const ordered = recommended
    ? [...pool].sort((a, b) => (a.id === recommended ? -1 : b.id === recommended ? 1 : 0))
    : pool
  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows ?? 0
  const wide = cols >= 90 && previewEntry !== undefined
  // Fill the terminal with results, leaving headroom for the message, the
  // description (taller when it carries a config example), and the shell prompt.
  const reserve = wide ? 16 : 4
  const pageSize = rows > 0 ? clamp(rows - reserve, 7, 30) : wide ? 8 : 12
  return askWithBack((ctx) =>
    search<string>(
      {
        message: `${message} (Esc to go back)`,
        pageSize,
        source: (term) => {
          const t = term?.toLowerCase().trim()
          let list: ModelCatalogEntry[]
          if (t) {
            const words = t.split(/\s+/)
            list = ordered
              .map((e) => ({ e, score: matchScore(e, words) }))
              .filter((x) => x.score > 0)
              .sort((a, b) => b.score - a.score)
              .map((x) => x.e)
          } else {
            list = ordered
          }
          const choices = list.slice(0, 200).map((e) => ({
            name: e.id === recommended ? `${fmtRow(e)}  * recommended` : fmtRow(e),
            value: e.id,
            description: describeChoice(e, wide, previewEntry)
          }))
          return [
            ...choices,
            { name: '<- Back', value: BACK, description: 'Return to the previous menu' }
          ]
        }
      },
      ctx
    )
  )
}

function previewText(alias: string, entry: ServeModelEntry, addon: string): string {
  const json = JSON.stringify({ [alias]: entry }, null, 2)
  return `\n${json}\n\n  Docs: ${docsUrlForAddon(addon)}\n`
}

function validateAlias(value: string, current: string, taken: Set<string>): string | true {
  const s = value.trim()
  if (!s) return 'Alias cannot be empty'
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) return 'Use letters, numbers, dot, dash or underscore'
  if (s !== current && taken.has(s)) return `Alias "${s}" is already used`
  return true
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

// Resolve the field list to edit. A plain object edits its fields directly; a
// discriminated union (tts / nmt / audiogen) first picks a variant, records the
// discriminator in the config, then edits that variant's fields.
async function configureFromModel(
  entry: ServeModelEntry,
  model: ConfigParamModel
): Promise<ServeModelEntry> {
  if (model.kind === 'object') return configureParams(entry, model.fields)

  // The discriminator (e.g. tts `ttsEngine`) is fixed by the model being
  // configured, so if the entry already pins it — preset templates do — edit
  // that variant's fields directly rather than offering to switch it, which
  // would desync the config from the model. Only ask when it's unset (a model
  // added via "search all" with no preset config).
  const current = entry.config?.[model.discriminator]
  let value = model.variants.find((v) => v.value === current)?.value
  if (value === undefined) {
    const picked = await askWithBack((ctx) =>
      select<string>(
        {
          message: `Select ${model.discriminator} (Esc to go back)`,
          choices: [
            ...model.variants.map((v) => ({ name: v.value, value: v.value })),
            { name: '<- Back', value: BACK }
          ]
        },
        ctx
      )
    )
    if (picked === BACK) return entry
    value = picked
  }
  const chosen = model.variants.find((v) => v.value === value)
  if (!chosen) return entry
  const withVariant: ServeModelEntry = {
    ...entry,
    config: { ...(entry.config ?? {}), [model.discriminator]: value }
  }
  return configureParams(withVariant, chosen.fields)
}

// Type hint plus a `required` marker, so mandatory fields are visible at a glance.
function fieldHint(field: ParamField): string {
  return field.required ? `${field.type}, required` : field.type
}

// Result of editing one field: a new value, clear it, or back out.
type FieldEdit = { value: unknown } | { clear: true } | typeof BACK

// Edit a single field. An object-capable field (e.g. a modelSrc
// `string | { src, … }`) offers text vs object, then drills into the object's
// own fields — edited exactly like top-level config, with descriptions — and
// the assembled object is validated before it's accepted.
async function editField(field: ParamField, current: unknown): Promise<FieldEdit> {
  if (field.objectFields) {
    let asObject = !field.acceptsString
    if (field.acceptsString) {
      const form = await askWithBack((ctx) =>
        select<string>(
          {
            message: `${field.name} — value type? (Esc to go back)`,
            choices: [
              {
                name: 'Text',
                value: 'text',
                description: field.description || 'A plain string value'
              },
              { name: 'Object', value: 'object', description: 'Edit its fields one by one' },
              { name: '<- Back', value: BACK }
            ]
          },
          ctx
        )
      )
      if (form === BACK) return BACK
      asObject = form === 'object'
    }
    if (asObject) {
      const base: Record<string, unknown> =
        current && typeof current === 'object' && !Array.isArray(current)
          ? { ...(current as Record<string, unknown>) }
          : {}
      for (;;) {
        const obj = await editProperties(base, field.objectFields, field.name)
        if (Object.keys(obj).length === 0) return { clear: true }
        const check = validateValue(field, obj)
        if (check === true) return { value: obj }
        const again = await confirm({ message: `${check} — keep editing?`, default: true })
        if (!again) return { clear: true }
        Object.assign(base, obj)
      }
    }
  }

  const raw = await askWithBack((ctx) =>
    input(
      {
        message: `${field.name} [${fieldHint(field)}]${field.description ? ` - ${field.description}` : ''}`,
        default:
          current !== undefined
            ? JSON.stringify(current)
            : field.default !== undefined
              ? JSON.stringify(field.default)
              : '',
        validate: (v) => validateParam(field, v)
      },
      ctx
    )
  )
  if (raw === BACK) return BACK
  const coerced = coerceParam(raw)
  return coerced === undefined ? { clear: true } : { value: coerced }
}

// Edit a set of properties one-by-one (search, pick, edit) — shared by
// top-level config and nested object fields, so objects are configured the same
// guided way as everything else. `label` names the object being edited, if nested.
async function editProperties(
  initial: Record<string, unknown>,
  fields: ParamField[],
  label?: string
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = { ...initial }
  const message = label
    ? `Set a field of ${label} (Esc when done)`
    : 'Set a parameter (Esc when done)'
  for (;;) {
    const pick = await askWithBack((ctx) =>
      search<string>(
        {
          message,
          source: (term) => {
            const t = term?.toLowerCase().trim()
            const list = t
              ? fields.filter(
                  (f) => f.name.toLowerCase().includes(t) || f.description.toLowerCase().includes(t)
                )
              : fields
            const rows = list.slice(0, 100).map((f) => ({
              name:
                config[f.name] !== undefined
                  ? `${f.name} = ${JSON.stringify(config[f.name])}   [${fieldHint(f)}]`
                  : `${f.name}   [${fieldHint(f)}]`,
              value: f.name,
              description: f.description
            }))
            return [
              ...rows,
              { name: '<- Done', value: BACK, description: 'Finish setting parameters' }
            ]
          }
        },
        ctx
      )
    )
    if (pick === BACK) break
    const field = fields.find((f) => f.name === pick)
    if (!field) continue
    const result = await editField(field, config[field.name])
    if (result === BACK) continue
    if ('clear' in result) delete config[field.name]
    else config[field.name] = result.value
  }
  return config
}

// Guided, schema-driven editing of a model's config params: each field carries
// its type hint and description from the SDK schema; object fields drill in.
// Esc / "Done" returns the updated entry.
async function configureParams(
  entry: ServeModelEntry,
  fields: ParamField[]
): Promise<ServeModelEntry> {
  const config = await editProperties(entry.config ?? {}, fields)
  if (Object.keys(config).length === 0) {
    const next = { ...entry }
    delete next.config
    return next
  }
  return { ...entry, config }
}

// Preview the entry, then Add / Rename / Set params / Edit / Back. The alias and
// config are editable before and after an $EDITOR pass; after any change the
// preview re-renders with the result, so the user sees the final entry before
// adding. Returns the confirmed addition, or BACK to return to the previous step.
async function confirmEntry(
  built: BuiltEntry,
  taken: Set<string>,
  canEdit: boolean
): Promise<AddedEntry | typeof BACK> {
  let alias = aliasFor(built.aliasBase, taken)
  let entry = built.entry
  const schema = configSchemaForAddon(built.addon)
  const model = schema ? configParamModel(schema) : null
  const hasParams =
    !!model && (model.kind === 'object' ? model.fields.length > 0 : model.variants.length > 0)
  for (;;) {
    const proceed = await askWithBack((ctx) =>
      select<string>(
        {
          message: `${previewText(alias, entry, built.addon)}Proceed? (Esc to go back)`,
          choices: [
            { name: `Add it (alias: ${alias})`, value: 'add' },
            { name: 'Rename alias...', value: 'alias' },
            ...(hasParams ? [{ name: 'Set config parameters...', value: 'params' }] : []),
            ...(canEdit ? [{ name: 'Edit in $EDITOR...', value: 'edit' }] : []),
            { name: '<- Back', value: 'back' }
          ]
        },
        ctx
      )
    )
    if (proceed === BACK || proceed === 'back') return BACK
    if (proceed === 'params' && model) {
      entry = await configureFromModel(entry, model)
      continue
    }
    if (proceed === 'alias') {
      const next = await askWithBack((ctx) =>
        input(
          {
            message: 'Alias',
            default: alias,
            validate: (v) => validateAlias(v, alias, taken)
          },
          ctx
        )
      )
      if (next !== BACK) alias = next.trim()
      continue
    }
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
    const modality = await askWithBack((ctx) =>
      select<Modality | typeof BACK>(
        {
          message: 'Capability? (Esc to go back)',
          choices: [
            ...MODALITIES.map((m) => ({ name: m.label, value: m.id })),
            { name: '<- Back', value: BACK }
          ]
        },
        ctx
      )
    )
    if (modality === BACK) return BACK

    const info = modalityInfo(modality)
    let constantName: string | undefined
    if (modality === 'speech') {
      // TTS isn't a single pickable constant — it's a per-engine assembly. Let
      // the user choose the engine; buildEntry supplies that engine's template.
      const engine = await askWithBack((ctx) =>
        select<string>(
          {
            message: 'Which TTS engine? (Esc to go back)',
            choices: [
              ...TTS_ENGINES.map((e) => ({
                name: TTS_ENGINE_TEMPLATES[e].label,
                value: e,
                description: TTS_ENGINE_TEMPLATES[e].hint
              })),
              { name: '<- Back', value: BACK }
            ]
          },
          ctx
        )
      )
      if (engine === BACK) continue
      constantName = engine
    } else if (info.pick) {
      const pool = catalog.filter((e) => e.role === info.role)
      const picked = await pickModel(pool, `Pick a ${info.label} model (type to search)`, {
        recommended: RECOMMENDED[modality],
        previewEntry: (id) => buildEntry(modality, id).entry
      })
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
    const picked = await pickModel(catalog, 'Search all models (type to search)', {
      previewEntry: (id, addon) => buildGenericEntry(id, addon).entry
    })
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
