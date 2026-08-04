import { expect, test } from 'bun:test'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  BUNDLED_SKILLS,
  BUNDLED_SKILLS_HASH,
  bundledSkillBundle,
  cleanupMaterializedSkills,
  createSelectedSkillsMaterializer,
  createSkillCatalogFromBundle,
  hashBundledSkills,
  materializeSelectedSkills,
  loadBundledSkillCatalog,
  parseToolGrant,
  resolveSkillCatalog,
  verifyBundledSkillsHash
} from '../lib/skills/index.ts'

test('catalog contains expected three entries', async (t) => {
  const catalog = await createSkillCatalogFromBundle(
    { files: BUNDLED_SKILLS, hash: BUNDLED_SKILLS_HASH },
    { platform: 'darwin' }
  )
  expect(catalog.map((entry) => entry.name)).toEqual(['image-generation', 'obsidian', 'weather'])
})

test('image-generation grants only generate_image', async () => {
  const catalog = await createSkillCatalogFromBundle(
    { files: BUNDLED_SKILLS, hash: BUNDLED_SKILLS_HASH },
    { platform: 'darwin' }
  )
  const image = catalog.find((entry) => entry.name === 'image-generation')
  expect(image).toBeDefined()
  expect(image?.tools).toEqual(['generate_image'])
})

test('rejects malformed skill manifest frontmatter', async () => {
  const malformedBundle = {
    files: {
      'broken/SKILL.md': ['---', 'name: broken', 'description: missing tools list', '---'].join('\n')
    },
    hash: ''
  }
  malformedBundle.hash = hashBundledSkills(malformedBundle.files)
  await expect(createSkillCatalogFromBundle(malformedBundle, { platform: 'darwin' })).rejects.toThrow(
    /required manifest field/i
  )
})

test('hashing is deterministic and mismatches are rejected', async () => {
  const files = {
    'b/file.txt': '2\n',
    'a/file.txt': '1\n'
  }
  const hashA = hashBundledSkills(files)
  const hashB = hashBundledSkills({
    'a/file.txt': '1\n',
    'b/file.txt': '2\n'
  })
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
    createSkillCatalogFromBundle(
      { files, hash: hashBundledSkills(files) },
      { platform: 'darwin' }
    )
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
  const hash = hashBundledSkills(files)
  const darwinCatalog = await createSkillCatalogFromBundle({ files, hash }, { platform: 'darwin' })
  expect(darwinCatalog.map((entry) => entry.name)).toEqual(['cross'])
})

test('parses scoped exec(obsidian) grant', () => {
  expect(parseToolGrant('exec(obsidian)')).toEqual({ name: 'exec', scope: 'obsidian' })
})

test('bundled catalog scopes by the platform the caller threads', async () => {
  const unscopedCatalog = await loadBundledSkillCatalog()
  const darwinCatalog = await loadBundledSkillCatalog({ platform: 'darwin' })
  const win32Catalog = await loadBundledSkillCatalog({ platform: 'win32' })
  const unscopedNames = unscopedCatalog.map((entry) => entry.name)
  const darwinNames = darwinCatalog.map((entry) => entry.name)
  const win32Names = win32Catalog.map((entry) => entry.name)

  // No implicit host default: an unscoped load sees every bundled skill.
  expect(unscopedNames).toContain('obsidian')
  expect(darwinNames).toContain('obsidian')
  expect(win32Names).not.toContain('obsidian')
  expect(darwinNames).not.toEqual(win32Names)
})

test('harness catalog is empty until an application supplies skills', async () => {
  expect(await resolveSkillCatalog(undefined)).toEqual([])
  expect(
    (await resolveSkillCatalog({ bundle: bundledSkillBundle(), platform: 'darwin' })).map(
      (entry) => entry.name
    )
  ).toContain('obsidian')

  const preloaded = await loadBundledSkillCatalog({ platform: 'darwin' })
  expect(await resolveSkillCatalog({ catalog: preloaded })).toBe(preloaded)
})

test('obsidian cli validation rejects absolute paths and traversal', async () => {
  const catalog = await createSkillCatalogFromBundle(
    { files: BUNDLED_SKILLS, hash: BUNDLED_SKILLS_HASH },
    { platform: 'darwin' }
  )
  const obsidian = catalog.find((entry) => entry.name === 'obsidian')
  expect(obsidian?.cliValidator).toBeDefined()
  expect(obsidian?.cliValidator?.check(['read', 'path=Projects/Note.md'])).toBeNull()
  expect(obsidian?.cliValidator?.check(['read', 'path=/tmp/note.md'])).toBeTruthy()
  expect(obsidian?.cliValidator?.check(['read', 'path=../../secret.md'])).toBeTruthy()
})

test('rejects malformed frontmatter delimiter syntax', async () => {
  const malformedBundle = {
    files: {
      'broken/SKILL.md': [
        '---',
        'name: broken',
        'description: malformed delimiter',
        'tools: [http_request]',
        '--',
        '',
        '# Broken skill body'
      ].join('\n')
    },
    hash: ''
  }
  malformedBundle.hash = hashBundledSkills(malformedBundle.files)
  await expect(createSkillCatalogFromBundle(malformedBundle, { platform: 'darwin' })).rejects.toThrow(
    /required manifest field/i
  )
})

test('materializes only selected skills with read-only files', async () => {
  const root = await materializeSelectedSkills({
    agentId: 'weather-agent',
    selectedSkills: ['weather'],
    bundle: { files: BUNDLED_SKILLS, hash: BUNDLED_SKILLS_HASH }
  })
  const entries = await readdir(root)
  expect(entries).toEqual(['weather'])
  await expect(readFile(path.join(root, 'obsidian', 'SKILL.md'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT'
  })

  const weatherSkill = path.join(root, 'weather', 'SKILL.md')
  const weatherMode = (await stat(weatherSkill)).mode & 0o777
  expect(weatherMode & 0o222).toBe(0)
  await cleanupMaterializedSkills(root)
})

test('materialized skill trees are private and read-only', async () => {
  const bundle = { files: BUNDLED_SKILLS, hash: BUNDLED_SKILLS_HASH }
  const root = await materializeSelectedSkills({
    agentId: 'private-agent',
    selectedSkills: ['weather'],
    bundle
  })
  const weatherDirectory = path.join(root, 'weather')
  const weatherSkill = path.join(weatherDirectory, 'SKILL.md')

  const rootMode = (await stat(root)).mode & 0o777
  const weatherDirectoryMode = (await stat(weatherDirectory)).mode & 0o777
  const weatherSkillMode = (await stat(weatherSkill)).mode & 0o777

  expect(rootMode).toBe(0o500)
  expect(weatherDirectoryMode).toBe(0o500)
  expect(weatherSkillMode).toBe(0o400)
  expect((await stat(path.dirname(root))).mode & 0o777).toBe(0o700)
  await cleanupMaterializedSkills(root)
})

test('same skill selection materializes into isolated per-agent roots and cleans up', async () => {
  const bundle = { files: BUNDLED_SKILLS, hash: BUNDLED_SKILLS_HASH }
  const first = await materializeSelectedSkills({
    agentId: 'agent-a',
    selectedSkills: ['weather'],
    bundle
  })
  const second = await materializeSelectedSkills({
    agentId: 'agent-b',
    selectedSkills: ['weather'],
    bundle
  })

  expect(first).not.toBe(second)
  expect(path.dirname(first)).not.toBe(path.dirname(second))
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

test('per-runtime materializer reuses one agent tree across idle restarts', async () => {
  const runtime = createSelectedSkillsMaterializer()
  const bundle = { files: BUNDLED_SKILLS, hash: BUNDLED_SKILLS_HASH }
  const first = await runtime.materialize({
    agentId: 'idle-agent',
    selectedSkills: ['weather'],
    bundle
  })
  const restarted = await runtime.materialize({
    agentId: 'idle-agent',
    selectedSkills: ['weather'],
    bundle
  })
  const other = await runtime.materialize({
    agentId: 'other-agent',
    selectedSkills: ['weather'],
    bundle
  })

  expect(restarted).toBe(first)
  expect(other).not.toBe(first)

  await runtime.close()
  await expect(access(first)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(other)).rejects.toMatchObject({ code: 'ENOENT' })
})
