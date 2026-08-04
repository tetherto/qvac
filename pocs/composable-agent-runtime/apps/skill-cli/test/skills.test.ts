import { expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  createSkillCatalogFromBundle,
  hashBundledSkills
} from '@qvac/harness/skill-host'
import { BUNDLED_SKILLS, BUNDLED_SKILLS_HASH } from '../lib/skills/bundled-skills.ts'
import { buildCliValidatorFromBundle } from '../lib/cli-schema.ts'

const BUNDLE = { files: BUNDLED_SKILLS, hash: BUNDLED_SKILLS_HASH }
const SKILLS_ROOT = new URL('../skills/', import.meta.url).pathname

test('this application ships the weather, obsidian, and image skills', async () => {
  const catalog = await createSkillCatalogFromBundle(BUNDLE, { platform: 'darwin' })
  expect(catalog.map((entry) => entry.name)).toEqual([
    'image-generation',
    'obsidian',
    'weather'
  ])
})

test('each skill grants exactly the tool its provider serves', async () => {
  const catalog = await createSkillCatalogFromBundle(BUNDLE, { platform: 'darwin' })
  const grants = Object.fromEntries(catalog.map((entry) => [entry.name, entry.tools]))
  expect(grants.weather).toEqual(['http_request'])
  expect(grants.obsidian).toEqual(['exec(obsidian)'])
  expect(grants['image-generation']).toEqual(['generate_image'])
})

test('skill bodies reach the catalog as instructions', async () => {
  const catalog = await createSkillCatalogFromBundle(BUNDLE, { platform: 'darwin' })
  const weather = catalog.find((entry) => entry.name === 'weather')
  expect(weather?.instructions).toContain('wttr.in')
})

test('obsidian cli validation rejects absolute paths and traversal', () => {
  const validator = buildCliValidatorFromBundle(
    'obsidian',
    ['exec(obsidian)'],
    BUNDLED_SKILLS
  )
  expect(validator).toBeDefined()
  expect(validator?.check(['read', 'path=Projects/Note.md'])).toBeNull()
  expect(validator?.check(['read', 'path=/tmp/note.md'])).toBeTruthy()
  expect(validator?.check(['read', 'path=../../secret.md'])).toBeTruthy()
})

// Without this, an edited SKILL.md silently keeps a stale generated bundle and
// the sandbox materializes prose the author never wrote.
test('the generated bundle matches the skills on disk', async () => {
  const files: Record<string, string> = {}
  for (const skill of await readdir(SKILLS_ROOT)) {
    for (const entry of await readdir(path.join(SKILLS_ROOT, skill))) {
      files[`${skill}/${entry}`] = await readFile(
        path.join(SKILLS_ROOT, skill, entry),
        'utf8'
      )
    }
  }
  expect(hashBundledSkills(files)).toBe(BUNDLED_SKILLS_HASH)
  expect(Object.keys(files).sort()).toEqual(Object.keys(BUNDLED_SKILLS).sort())
})
