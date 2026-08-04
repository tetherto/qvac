import { expect, test } from 'bun:test'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  cleanupMaterializedSkills,
  createSelectedSkillsMaterializer,
  createSkillCatalogFromBundle,
  composeSkillPrompt,
  hashBundledSkills,
  materializeSelectedSkills,
  parseToolGrant,
  resolveSkillCatalog,
  verifyBundledSkillsHash
} from '../lib/skills/index.ts'
import { fixtureSkillBundle } from './skill-fixtures.ts'

// Harness owns generic skill machinery, not any particular skill, so these
// exercise a synthetic bundle rather than whatever an application ships.
const BUNDLE = fixtureSkillBundle()

test('a catalog is built from a bundle and sorted by name', async () => {
  const catalog = await createSkillCatalogFromBundle(BUNDLE)
  expect(catalog.map((entry) => entry.name)).toEqual([
    'danger',
    'image-generation',
    'notes',
    'weather'
  ])
})

test('a catalog entry keeps its grants and instructions', async () => {
  const catalog = await createSkillCatalogFromBundle(BUNDLE)
  const weather = catalog.find((entry) => entry.name === 'weather')
  expect(weather?.tools).toEqual(['http_request'])
  expect(weather?.instructions).toContain('Fixture instructions for the weather skill')
})

test('rejects malformed skill manifest frontmatter', async () => {
  const files = {
    'broken/SKILL.md': ['---', 'name: broken', 'description: missing tools list', '---'].join('\n')
  }
  await expect(
    createSkillCatalogFromBundle({ files, hash: hashBundledSkills(files) })
  ).rejects.toThrow(/required manifest field/i)
})

test('rejects malformed frontmatter delimiter syntax', async () => {
  const files = {
    'broken/SKILL.md': [
      '---',
      'name: broken',
      'description: malformed delimiter',
      'tools: [http_request]',
      '--',
      '',
      '# Broken skill body'
    ].join('\n')
  }
  await expect(
    createSkillCatalogFromBundle({ files, hash: hashBundledSkills(files) })
  ).rejects.toThrow(/required manifest field/i)
})

test('hashing is deterministic and mismatches are rejected', async () => {
  const files = { 'b/file.txt': '2\n', 'a/file.txt': '1\n' }
  const hashA = hashBundledSkills(files)
  const hashB = hashBundledSkills({ 'a/file.txt': '1\n', 'b/file.txt': '2\n' })
  expect(hashA).toBe(hashB)
  expect(hashA).toHaveLength(64)
  await expect(verifyBundledSkillsHash(files, 'deadbeefdeadbeef')).rejects.toThrow(
    /bundle hash mismatch/i
  )
})

test('rejects a manifest whose name differs from its skill directory', async () => {
  const files = {
    'weather/SKILL.md': [
      '---',
      'name: impostor',
      'description: mismatched name',
      'tools: [http_request]',
      '---',
      ''
    ].join('\n')
  }
  await expect(
    createSkillCatalogFromBundle({ files, hash: hashBundledSkills(files) })
  ).rejects.toThrow(/name.*directory/i)
})

test('applies platform filtering', async () => {
  const files = {
    'cross/SKILL.md': [
      '---',
      'name: cross',
      'description: cross',
      'tools: [http_request]',
      '---',
      ''
    ].join('\n'),
    'linux-only/SKILL.md': [
      '---',
      'name: linux-only',
      'description: linux',
      'tools: [http_request]',
      'platform: [linux]',
      '---',
      ''
    ].join('\n')
  }
  const bundle = { files, hash: hashBundledSkills(files) }
  const darwin = await createSkillCatalogFromBundle(bundle, { platform: 'darwin' })
  expect(darwin.map((entry) => entry.name)).toEqual(['cross'])
  // No implicit host default: an unscoped load sees every bundled skill.
  const unscoped = await createSkillCatalogFromBundle(bundle)
  expect(unscoped.map((entry) => entry.name)).toEqual(['cross', 'linux-only'])
})

test('parses scoped exec grants', () => {
  expect(parseToolGrant('exec(obsidian)')).toEqual({ name: 'exec', scope: 'obsidian' })
  expect(parseToolGrant('http_request')).toEqual({ name: 'http_request', scope: null })
})

test('harness catalog is empty until an application supplies skills', async () => {
  expect(await resolveSkillCatalog(undefined)).toEqual([])
  const fromBundle = await resolveSkillCatalog({ bundle: BUNDLE })
  expect(fromBundle.map((entry) => entry.name)).toContain('weather')
  const preloaded = await createSkillCatalogFromBundle(BUNDLE)
  expect(await resolveSkillCatalog({ catalog: preloaded })).toBe(preloaded)
})

test('prompt blocks index every skill and expand only the selected ones', async () => {
  const catalog = await createSkillCatalogFromBundle(BUNDLE)
  const blocks = composeSkillPrompt({ catalog, selected: ['weather'] })
  expect(blocks[0]?.id).toBe('skills-index')
  expect(blocks[0]?.text).toContain('notes')
  expect(blocks.map((block) => block.id)).toEqual(['skills-index', 'skill:weather'])
})

test('a long skill body is truncated with an explicit marker', async () => {
  const catalog = await createSkillCatalogFromBundle(BUNDLE)
  const blocks = composeSkillPrompt({
    catalog,
    selected: ['weather'],
    maxBodyChars: 10
  })
  expect(blocks[1]?.text).toContain('[skill instructions truncated]')
})

test('materializes only selected skills with read-only files', async () => {
  const root = await materializeSelectedSkills({
    agentId: 'weather-agent',
    selectedSkills: ['weather'],
    bundle: BUNDLE
  })
  expect(await readdir(root)).toEqual(['weather'])
  await expect(readFile(path.join(root, 'notes', 'SKILL.md'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT'
  })

  const skill = path.join(root, 'weather', 'SKILL.md')
  expect((await stat(skill)).mode & 0o222).toBe(0)
  await cleanupMaterializedSkills(root)
})

test('materialized skill trees are private and read-only', async () => {
  const root = await materializeSelectedSkills({
    agentId: 'private-agent',
    selectedSkills: ['weather'],
    bundle: BUNDLE
  })
  const directory = path.join(root, 'weather')
  expect((await stat(root)).mode & 0o777).toBe(0o500)
  expect((await stat(directory)).mode & 0o777).toBe(0o500)
  expect((await stat(path.join(directory, 'SKILL.md'))).mode & 0o777).toBe(0o400)
  expect((await stat(path.dirname(root))).mode & 0o777).toBe(0o700)
  await cleanupMaterializedSkills(root)
})

test('same selection materializes into isolated per-agent roots and cleans up', async () => {
  const first = await materializeSelectedSkills({
    agentId: 'agent-a',
    selectedSkills: ['weather'],
    bundle: BUNDLE
  })
  const second = await materializeSelectedSkills({
    agentId: 'agent-b',
    selectedSkills: ['weather'],
    bundle: BUNDLE
  })

  expect(first).not.toBe(second)
  expect(path.dirname(first)).not.toBe(path.dirname(second))
  // Isolated roots, identical contents: the per-agent split is about the tree,
  // not about what each agent gets to read.
  expect(await readFile(path.join(first, 'weather', 'SKILL.md'), 'utf8')).toBe(
    await readFile(path.join(second, 'weather', 'SKILL.md'), 'utf8')
  )
  await cleanupMaterializedSkills(first)
  await expect(access(first)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(path.join(second, 'weather', 'SKILL.md'), 'utf8')).toContain(
    'name: weather'
  )
  await cleanupMaterializedSkills(second)
  await expect(access(second)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a materializer reuses one tree per selection and replaces it on change', async () => {
  const materializer = createSelectedSkillsMaterializer()
  const first = await materializer.materialize({
    agentId: 'agent-a',
    selectedSkills: ['weather'],
    bundle: BUNDLE
  })
  const again = await materializer.materialize({
    agentId: 'agent-a',
    selectedSkills: ['weather'],
    bundle: BUNDLE
  })
  expect(again).toBe(first)

  const changed = await materializer.materialize({
    agentId: 'agent-a',
    selectedSkills: ['weather', 'notes'],
    bundle: BUNDLE
  })
  expect(changed).not.toBe(first)
  await expect(access(first)).rejects.toMatchObject({ code: 'ENOENT' })

  // A second agent so close() has to reclaim more than the one live tree.
  const other = await materializer.materialize({
    agentId: 'agent-b',
    selectedSkills: ['weather'],
    bundle: BUNDLE
  })
  expect(other).not.toBe(changed)

  // Trees are mode 0500, so only the materializer can remove them. Closing has
  // to reclaim every live tree or callers are left with undeletable roots.
  await materializer.close()
  await expect(access(changed)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(other)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('materializing an unknown skill fails rather than shipping an empty tree', async () => {
  await expect(
    materializeSelectedSkills({
      agentId: 'agent-x',
      selectedSkills: ['missing'],
      bundle: BUNDLE
    })
  ).rejects.toThrow(/missing/)
})
