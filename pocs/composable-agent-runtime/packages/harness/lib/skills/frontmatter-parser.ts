import type { SkillRequires, SkillSetup } from './manifest.ts'
import { parseManifestBlock } from './manifest-parse.ts'

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
const FIELD_RE = /^([A-Za-z_][\w-]*):(.*)$/
const LIST_FIELDS = new Set(['tools', 'platform', 'allow_list'])

export interface SkillFrontMatter {
  name?: string
  description?: string
  tools?: string[]
  platform?: string[]
  allowList?: string[]
  requires?: SkillRequires
  setup?: SkillSetup
}

export interface ParsedSkill {
  meta: SkillFrontMatter
  body: string
  rawBlock: string
}

export function parseSkillFrontMatter(raw: string): ParsedSkill {
  const match = FRONT_MATTER_RE.exec(raw)
  if (!match) return { meta: {}, body: raw, rawBlock: '' }
  const block = match[1] ?? ''
  const meta = { ...parseFields(block), ...parseManifestBlock(block) }
  return { meta, body: (match[2] ?? '').trim(), rawBlock: block }
}

export function assertRequiredManifest(meta: SkillFrontMatter): void {
  if (!meta.name || meta.name.trim().length === 0) {
    throw new Error('required manifest field "name" is missing')
  }
  if (!meta.description || meta.description.trim().length === 0) {
    throw new Error('required manifest field "description" is missing')
  }
  if (!Array.isArray(meta.tools) || meta.tools.length === 0) {
    throw new Error('required manifest field "tools" is missing')
  }
}

function parseFields(block: string): SkillFrontMatter {
  const meta: SkillFrontMatter = {}
  for (const line of unwrap(block.split(/\r?\n/))) {
    const field = FIELD_RE.exec(line)
    if (!field) continue
    const key = field[1] ?? ''
    const value = (field[2] ?? '').trim()
    if (!value) continue
    if (key === 'allow_list') meta.allowList = parseList(value)
    else if (LIST_FIELDS.has(key)) meta[key as 'tools' | 'platform'] = parseList(value)
    else if (key === 'name' || key === 'description') meta[key] = stripQuotes(value)
  }
  return meta
}

function unwrap(lines: string[]): string[] {
  const result: string[] = []
  for (const line of lines) {
    if (result.length > 0 && /^\s/.test(line) && line.trim().length > 0) {
      result[result.length - 1] += ` ${line.trim()}`
    } else {
      result.push(line)
    }
  }
  return result
}

function parseList(value: string): string[] {
  const inline = /^\[(.*)\]$/.exec(value)
  const items = inline ? (inline[1] ?? '') : value.replace(/(^|\s)-\s+/g, ',')
  return items
    .split(',')
    .map((item) => stripQuotes(item.trim()))
    .filter((item) => item.length > 0)
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}
