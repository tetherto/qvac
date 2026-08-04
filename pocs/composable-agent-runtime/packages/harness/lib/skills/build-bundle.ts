import fs from 'node:fs'
import path from 'node:path'
import { hashBundledSkills } from './bundled-hash.ts'

export interface BuiltSkillBundle {
  files: Record<string, string>
  hash: string
}

export function buildBundleFromDirectory(skillsDirectory: string): BuiltSkillBundle {
  const files = collect(skillsDirectory, '')
  const ordered = Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  )
  return {
    files: ordered,
    hash: hashBundledSkills(ordered)
  }
}

function collect(root: string, prefix: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) {
      Object.assign(files, collect(target, relativePath))
    } else {
      files[relativePath] = fs.readFileSync(target, 'utf8')
    }
  }
  return files
}
