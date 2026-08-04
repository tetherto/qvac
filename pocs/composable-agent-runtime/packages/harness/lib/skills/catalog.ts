import { buildCliValidatorFromBundle, type CliValidator } from './cli-schema.ts'
import { assertRequiredManifest, parseSkillFrontMatter } from './frontmatter-parser.ts'
import type { SkillRequires, SkillSetup } from './manifest.ts'
import { verifyBundledSkillsHash } from './bundled-hash.ts'

export interface SkillCatalogEntry {
  name: string
  description: string
  tools: string[]
  allowList: string[]
  platform: string[]
  requires?: SkillRequires
  setup?: SkillSetup
  cliValidator?: CliValidator
}

export interface SkillBundleArtifact {
  files: Readonly<Record<string, string>>
  hash: string
}

export interface LoadCatalogOptions {
  platform?: string
}

/**
 * Where a harness gets its skills. Applications own skill bundles; the harness
 * only knows how to verify, parse, and materialize them.
 */
export type SkillCatalogSource =
  | { readonly bundle: SkillBundleArtifact; readonly platform?: string }
  | { readonly catalog: readonly SkillCatalogEntry[] }

export async function resolveSkillCatalog(
  source: SkillCatalogSource | undefined
): Promise<readonly SkillCatalogEntry[]> {
  if (!source) return []
  if ('catalog' in source) return source.catalog
  return createSkillCatalogFromBundle(
    source.bundle,
    source.platform === undefined ? {} : { platform: source.platform }
  )
}

export async function createSkillCatalogFromBundle(
  bundle: SkillBundleArtifact,
  { platform }: LoadCatalogOptions = {}
): Promise<SkillCatalogEntry[]> {
  await verifyBundledSkillsHash(bundle.files, bundle.hash)
  const skillNames = collectSkillNames(bundle.files)
  const entries = skillNames.map((skillName) => loadEntry(bundle.files, skillName))
  return entries
    .filter((entry) => supportsPlatform(entry.platform, platform))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function collectSkillNames(files: Readonly<Record<string, string>>): string[] {
  const names = new Set<string>()
  for (const filePath of Object.keys(files)) {
    const [first, second] = filePath.split('/')
    if (first && second === 'SKILL.md') names.add(first)
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

function loadEntry(files: Readonly<Record<string, string>>, skillName: string): SkillCatalogEntry {
  const raw = files[`${skillName}/SKILL.md`]
  if (!raw) throw new Error(`missing SKILL.md for ${skillName}`)
  const { meta, rawBlock } = parseSkillFrontMatter(raw)
  assertRequiredManifest(meta)
  if (meta.name !== skillName) {
    throw new Error(
      `skill manifest name "${meta.name}" must equal directory name "${skillName}"`
    )
  }
  if (rawBlock.includes('metadata:') && !meta.requires && !meta.setup) {
    throw new Error(`required manifest field parsing failed for ${skillName}`)
  }

  const tools = [...(meta.tools ?? [])]
  const entry: SkillCatalogEntry = {
    name: skillName,
    description: meta.description ?? '',
    tools,
    allowList: [...(meta.allowList ?? [])],
    platform: [...(meta.platform ?? [])],
    ...(meta.requires ? { requires: meta.requires } : {}),
    ...(meta.setup ? { setup: meta.setup } : {})
  }
  const validator = buildCliValidatorFromBundle(skillName, tools, files)
  if (validator) entry.cliValidator = validator
  return entry
}

function supportsPlatform(platforms: readonly string[], platform: string | undefined): boolean {
  if (!platform || platforms.length === 0) return true
  return platforms.includes(platform)
}
