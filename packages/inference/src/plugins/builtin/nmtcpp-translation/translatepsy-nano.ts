import { PluginLoadConfigValidationFailedError } from '@/errors/index'
import { ModelType, type BergamotLanguage } from '@/schemas/index'

/**
 * TranslatePsy-AfriNano / -EuroNano: multilingual Bergamot packs, one per
 * direction. An `en-xx` pack translates English into any of its family's
 * languages and picks the target from a `##<TO>` tag (upper-case ISO 639-1
 * code plus a space) at the start of the input; an `xx-en` pack translates any
 * of them into English and takes no tag. Untagged `en-xx` input decodes into
 * no particular language, so QVAC adds the tag itself.
 */
export const TRANSLATEPSY_NANO_LANGUAGES = {
  AfriNano: ['am', 'ha', 'ig', 'ln', 'so', 'sw', 'yo', 'zu'],
  EuroNano: ['de', 'es', 'fr', 'it', 'pt', 'fi', 'cs', 'nl', 'sv']
} as const satisfies Record<string, readonly BergamotLanguage[]>

export type TranslatePsyNanoFamily = keyof typeof TRANSLATEPSY_NANO_LANGUAGES
export type TranslatePsyNanoDirection = 'en-xx' | 'xx-en'

export interface TranslatePsyNanoPack {
  /** Unknown for a copy that kept neither its registry name nor its repo directory. */
  family?: TranslatePsyNanoFamily
  direction: TranslatePsyNanoDirection
}

const FAMILIES: Record<string, TranslatePsyNanoFamily> = {
  afrinano: 'AfriNano',
  euronano: 'EuroNano'
}

// The Hugging Face repo layout, which registry paths (and so the registry
// constants' `src`), Hub URLs, `huggingface-cli download` and the Hub cache all
// keep. Detection reads the source only, never the registry name: loads that
// share a source and config share one model, so their tagging must agree.
const PACK_LAYOUT_RE =
  /(?:^|[/\\])(en-xx|xx-en)[/\\](?:Base|BaseMemory|Tiny)[/\\]intgemm[/\\]model\.intgemm\.alphas\.bin$/i
// `qvac/TranslatePsy-AfriNano/…`, `models--qvac--TranslatePsy-AfriNano/snapshots/…`.
const PACK_FAMILY_RE = /TranslatePsy-(AfriNano|EuroNano)(?=[/\\])/i

const TARGET_TAG_RE = /^\s*##[A-Z]{2,3}(?:\s|$)/
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

// A URL's query and fragment are not part of its path: Hub download links end
// in `?download=true`. A local path is read as written, since `?` and `#` are
// valid in file names.
function sourcePath(modelSrc: string): string {
  return URL_SCHEME_RE.test(modelSrc) ? modelSrc.replace(/[?#].*$/, '') : modelSrc
}

/** Detects a TranslatePsy Nano pack from its source path. */
export function detectTranslatePsyNanoPack(modelSrc: string): TranslatePsyNanoPack | null {
  const path = sourcePath(modelSrc)
  const layout = path.match(PACK_LAYOUT_RE)
  if (!layout?.[1]) return null

  const family = path.match(PACK_FAMILY_RE)?.[1]
  return {
    ...(family && { family: FAMILIES[family.toLowerCase()]! }),
    direction: layout[1].toLowerCase() as TranslatePsyNanoDirection
  }
}

function invalid(details: string): PluginLoadConfigValidationFailedError {
  return new PluginLoadConfigValidationFailedError(ModelType.nmtcppTranslation, details)
}

/**
 * The TranslatePsy Nano pack a Bergamot load runs, or null for a plain
 * Bergamot model. `targetTag: false` opts a detected file out; `true` marks a
 * copy that lost its layout as an `en-xx` pack.
 */
export function resolveTranslatePsyNanoPack(input: {
  targetTag?: boolean | undefined
  modelSrc: string
}): TranslatePsyNanoPack | null {
  if (input.targetTag === false) return null

  const detected = detectTranslatePsyNanoPack(input.modelSrc)
  if (input.targetTag !== true) return detected

  if (detected?.direction === 'xx-en') {
    throw invalid(
      `targetTag selects the output language of an English→X (en-xx) TranslatePsy Nano pack, but ${input.modelSrc} is an xx-en pack, which takes no tag. Remove targetTag.`
    )
  }
  return { ...(detected?.family && { family: detected.family }), direction: 'en-xx' }
}

/**
 * Checks a load's `from`/`to` against the pack's family and direction.
 * A TranslatePsy Nano pack only translates to or from English; X→Y goes
 * through English as two loads (the addon's in-model pivot passes the first
 * leg's output to the second unchanged, so it cannot carry an en-xx target tag).
 */
export function assertTranslatePsyNanoLanguages(
  pack: TranslatePsyNanoPack,
  from: string,
  to: string,
  hasPivot: boolean
): void {
  const languages: readonly string[] = pack.family
    ? TRANSLATEPSY_NANO_LANGUAGES[pack.family]
    : Object.values(TRANSLATEPSY_NANO_LANGUAGES).flat()
  const label = pack.family ? `TranslatePsy-${pack.family}` : 'TranslatePsy Nano'
  const list = languages.join(', ')

  if (pack.direction === 'en-xx' && hasPivot) {
    throw invalid(
      `${label} en-xx packs cannot be the first leg of a pivotModel load: their target tag would have to name the intermediate language, which a pivot load does not declare. Load each pack separately and translate twice.`
    )
  }

  if (from !== 'en' && to !== 'en' && !hasPivot) {
    throw invalid(
      `${label} packs translate to or from English only. For ${from}→${to}, load an xx-en pack (${from}→en) and an en-xx pack (en→${to}) and translate twice: pivotModel cannot carry the ##${to.toUpperCase()} target tag to its second leg.`
    )
  }

  if (pack.direction === 'en-xx') {
    if (from !== 'en') {
      throw invalid(
        `${label} en-xx packs translate from English (from: 'en'), got from: '${from}'. Load the xx-en pack for ${from}→${to}.`
      )
    }
    if (!languages.includes(to)) {
      throw invalid(`${label} en-xx packs translate into ${list}, got to: '${to}'.`)
    }
    return
  }

  if (from === 'en') {
    throw invalid(
      `${label} xx-en packs translate into English, got from: 'en'. Load the en-xx pack for en→${to}.`
    )
  }
  if (!languages.includes(from)) {
    throw invalid(`${label} xx-en packs translate from ${list}, got from: '${from}'.`)
  }
}

/**
 * Rejects a pivotModel that is a TranslatePsy Nano en-xx pack: the second leg
 * receives the first leg's output as-is, so it never sees a target tag.
 */
export function assertTranslatePsyNanoPivot(pivotModelSrc: string, to: string): void {
  if (detectTranslatePsyNanoPack(pivotModelSrc)?.direction !== 'en-xx') return
  throw invalid(
    `pivotModel ${pivotModelSrc} is a TranslatePsy Nano en-xx pack, which needs a ##${to.toUpperCase()} target tag that the in-model pivot cannot add between legs. Load the two packs separately and translate twice (xx-en, then en-xx).`
  )
}

/** The `##<TO>` tag for a loaded model's config, or undefined when it takes none. */
export function translatePsyNanoTargetTag(config: unknown): string | undefined {
  const cfg = config as { engine?: unknown; targetTag?: unknown; to?: unknown } | undefined
  if (cfg?.engine !== 'Bergamot' || cfg.targetTag !== true || typeof cfg.to !== 'string') {
    return undefined
  }
  return `##${cfg.to.toUpperCase()}`
}

/**
 * Prepends the target tag. Input that already starts with a `##XX` tag is sent
 * as-is, so a batch can mix targets and hand-tagged text is never tagged twice.
 */
export function withTargetTag(text: string, tag: string): string {
  return TARGET_TAG_RE.test(text) ? text : `${tag} ${text}`
}
