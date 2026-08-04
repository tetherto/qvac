import crypto from '#crypto'
import fs from '#fs-promises'
import os from '#os'
import path from '#path'
import type { SkillBundleArtifact } from './catalog.ts'
import { verifyBundledSkillsHash } from './bundled-hash.ts'

export interface MaterializeSelectedSkillsOptions {
  agentId: string
  selectedSkills: readonly string[]
  bundle: SkillBundleArtifact
  temporaryRoot?: string
}

export interface SelectedSkillsMaterializer {
  materialize(
    options: Omit<MaterializeSelectedSkillsOptions, 'temporaryRoot'>
  ): Promise<string>
  close(): Promise<void>
}

interface OwnedMaterialization {
  readonly runtimeRoot: string
  readonly uid: number
}

const ownedMaterializations = new Map<string, OwnedMaterialization>()

export function createSelectedSkillsMaterializer(
  options: { readonly temporaryRoot?: string } = {}
): SelectedSkillsMaterializer {
  const entries = new Map<
    string,
    {
      readonly key: string
      readonly root: Promise<string>
    }
  >()
  let closed = false
  let closing: Promise<void> | undefined

  return {
    async materialize(input) {
      if (closed) throw new Error('skill materializer is closed')
      const key = materializationSelectionKey(
        input.selectedSkills,
        input.bundle.hash
      )
      const existing = entries.get(input.agentId)
      if (existing?.key === key) return existing.root
      if (existing) {
        await cleanupMaterializedSkills(await existing.root)
        if (entries.get(input.agentId) === existing) {
          entries.delete(input.agentId)
        }
      }
      const root = materializeSelectedSkills({
        ...input,
        ...(options.temporaryRoot
          ? { temporaryRoot: options.temporaryRoot }
          : {})
      })
      const entry = { key, root }
      entries.set(input.agentId, entry)
      try {
        return await root
      } catch (error) {
        if (entries.get(input.agentId) === entry) {
          entries.delete(input.agentId)
        }
        throw error
      }
    },
    async close() {
      if (closed) return
      closing ??= closeEntries().finally(() => {
        closing = undefined
      })
      await closing
    }
  }

  async function closeEntries() {
    const results = await Promise.allSettled(
      [...entries].map(async ([agentId, entry]) => {
        await cleanupMaterializedSkills(await entry.root)
        if (entries.get(agentId) === entry) {
          entries.delete(agentId)
        }
      })
    )
    const errors = results.flatMap((result) =>
      result.status === 'rejected'
        ? [toError(result.reason)]
        : []
    )
    if (errors.length === 0) {
      closed = true
      return
    }
    if (errors.length === 1) throw errors[0]
    throw new AggregateError(errors, 'skill materializer close failed')
  }
}

export async function materializeSelectedSkills({
  agentId,
  selectedSkills,
  bundle,
  temporaryRoot = os.tmpdir()
}: MaterializeSelectedSkillsOptions): Promise<string> {
  await verifyBundledSkillsHash(bundle.files, bundle.hash)
  const canonicalTemporaryRoot = await fs.realpath(temporaryRoot)
  const runtimeRoot = path.join(
    canonicalTemporaryRoot,
    `qvac-harness-skills-runtime-${randomSuffix()}`
  )
  await fs.mkdir(runtimeRoot, { mode: 0o700 })
  const uid = await createdDirectoryUid(runtimeRoot, 0o700)
  await assertOwnedDirectory(runtimeRoot, uid, 0o700)
  const directory = path.join(
    runtimeRoot,
    `agent-${agentKey(agentId)}-${randomSuffix()}`
  )
  try {
    await fs.mkdir(directory, { mode: 0o700 })
    await assertOwnedDirectory(directory, uid, 0o700)
    await writeSelectedTree(directory, selectedSkills, bundle.files)
    await makeTreeReadOnly(directory)
    if (!(await isValidMaterialization(directory, selectedSkills, bundle.files))) {
      throw new Error('materialized skills failed content verification')
    }
    if (!(await hasStrictPrivateModes(directory, uid))) {
      throw new Error('materialized skills failed owner and mode verification')
    }
    ownedMaterializations.set(directory, { runtimeRoot, uid })
    return directory
  } catch (error) {
    await removeOwnedTree(runtimeRoot, uid)
    throw error
  }
}

export async function cleanupMaterializedSkills(directory: string): Promise<void> {
  const owned = ownedMaterializations.get(directory)
  if (!owned) {
    throw new Error('refusing to clean an unowned skill materialization')
  }
  await removeOwnedTree(owned.runtimeRoot, owned.uid)
  ownedMaterializations.delete(directory)
}

function agentKey(agentId: string) {
  return crypto.createHash('sha256').update(agentId).digest('hex').slice(0, 16)
}

function materializationSelectionKey(
  selectedSkills: readonly string[],
  bundleHash: string
) {
  return `${bundleHash}\0${[...new Set(selectedSkills)].sort().join('\0')}`
}

async function writeSelectedTree(
  root: string,
  selectedSkills: readonly string[],
  files: Readonly<Record<string, string>>
): Promise<void> {
  const selected = new Set(selectedSkills)
  const available = new Set(Object.keys(files).map((file) => file.split('/')[0]).filter(Boolean))
  for (const skillName of selected) {
    if (!available.has(skillName)) throw new Error(`unknown selected skill: ${skillName}`)
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const skillName = relativePath.split('/')[0]
    if (!skillName || !selected.has(skillName)) continue
    const target = path.join(root, relativePath)
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await fs.writeFile(target, content, { mode: 0o600 })
  }
}

async function makeTreeReadOnly(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await makeTreeReadOnly(target)
      await fs.chmod(target, 0o500)
    } else if (entry.isFile()) {
      await fs.chmod(target, 0o400)
    }
  }
  await fs.chmod(root, 0o500)
}

async function isValidMaterialization(
  root: string,
  selectedSkills: readonly string[],
  files: Readonly<Record<string, string>>
): Promise<boolean> {
  try {
    const selected = new Set(selectedSkills)
    const diskFiles = await collectFiles(root)
    const expected = Object.entries(files)
      .filter(([relativePath]) => selected.has(relativePath.split('/')[0] ?? ''))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    if (diskFiles.length !== expected.length) return false
    for (let index = 0; index < expected.length; index++) {
      const [expectedPath, expectedContent] = expected[index] as [string, string]
      const actual = diskFiles[index]
      if (!actual) return false
      if (actual.path !== expectedPath) return false
      if (actual.content !== expectedContent) return false
    }
    return true
  } catch {
    return false
  }
}

async function hasStrictPrivateModes(root: string, uid: number): Promise<boolean> {
  const rootStat = await fs.stat(root)
  if (rootStat.uid !== uid || (rootStat.mode & 0o777) !== 0o500) return false
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    const entryStat = await fs.stat(target)
    if (entryStat.uid !== uid) return false
    const mode = entryStat.mode & 0o777
    if (entry.isDirectory()) {
      if (mode !== 0o500) return false
      if (!(await hasStrictPrivateModes(target, uid))) return false
      continue
    }
    if (mode !== 0o400) return false
    if (!entry.isFile()) return false
  }
  return true
}

async function removeOwnedTree(root: string, uid: number): Promise<void> {
  const entry = await fs.lstat(root).catch(() => undefined)
  if (!entry) return
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid) {
    throw new Error('skill materialization ownership verification failed')
  }
  await makeTreeWritable(root, uid)
  await fs.rm(root, { recursive: true, force: true })
}

async function makeTreeWritable(root: string, uid: number): Promise<void> {
  const rootStat = await fs.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== uid) {
    throw new Error('skill materialization ownership verification failed')
  }
  await fs.chmod(root, 0o700)
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const target = path.join(root, entry.name)
    const entryStat = await fs.lstat(target)
    if (entryStat.isSymbolicLink() || entryStat.uid !== uid) {
      throw new Error('skill materialization ownership verification failed')
    }
    if (entry.isDirectory()) {
      await makeTreeWritable(target, uid)
    } else if (entry.isFile()) {
      await fs.chmod(target, 0o600)
    }
  }
}

async function collectFiles(root: string, prefix = ''): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(target, relativePath)))
      continue
    }
    if (!entry.isFile()) throw new Error(`unsupported entry in skill tree: ${relativePath}`)
    files.push({
      path: relativePath,
      content: await fs.readFile(target, 'utf8')
    })
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return files
}

function randomSuffix(): string {
  return crypto.randomBytes(16).toString('hex')
}

async function assertOwnedDirectory(
  directory: string,
  uid: number,
  expectedMode: number
) {
  const entry = await fs.lstat(directory)
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    entry.uid !== uid ||
    (entry.mode & 0o777) !== expectedMode
  ) {
    throw new Error('skill materialization owner or mode is invalid')
  }
}

async function createdDirectoryUid(directory: string, expectedMode: number) {
  const entry = await fs.lstat(directory)
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    !Number.isSafeInteger(entry.uid) ||
    entry.uid < 0 ||
    (entry.mode & 0o777) !== expectedMode
  ) {
    throw new Error('new skill materialization directory is not owner-only')
  }
  return entry.uid
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}
