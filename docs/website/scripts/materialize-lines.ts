#!/usr/bin/env bun
/**
 * Materialize every documentation line from the commit it is pinned to.
 *
 * Usage:
 *   bun run scripts/materialize-lines.ts [--override <software>@<line>=<path|sha>]... [--include-dev]
 *
 * For each pinned line declared under `versions/`:
 *
 *   1. The line's declared paths are extracted from its commit into
 *      `.lines/<software>/<version>/`, a gitignored snapshot that mirrors the
 *      repository layout. Examples, contracts, and generated data therefore
 *      come from the same commit as the pages.
 *   2. Example sources in the snapshot are transpiled to `dist/examples`, as
 *      `prebuild:examples` does for `main`'s working tree.
 *   3. The documentation root (the first declared path) is copied to the
 *      line's folder under `content/docs/<software path>/`, written as the
 *      folder group when the line is current. The folder carries a
 *      `.materialized` marker and a `.gitignore` that ignores itself, so it is
 *      never committed and is cleaned when its line stops being declared.
 *
 * In-place lines — still held under `content/docs/` from before a package
 * migration — are left untouched.
 *
 * `--override <software>@<line>=<value>` substitutes one declared line:
 * `<value>` is either a commit or a directory holding a checkout of the
 * repository (`.` style paths are resolved from the monorepo root), used for
 * pull-request previews. `--include-dev` adds every versioned collection's
 * unreleased line, read from the monorepo's working tree, as `preview` — for
 * local and staging previews only; production builds never pass it.
 * `DOCS_MATERIALIZE_FLAGS` appends flags from the environment, so a build run
 * through `npm run build` can carry them.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { declaredSoftware } from '../src/lib/versions'
import { isPinnedLine, type VersionsFile } from '../src/lib/versions-file'
import { LOCK_FILE } from './bindings/bindings'

/** Top-level entries of a documentation root that are not part of its page tree. */
const SNAPSHOT_ONLY = new Set(['_generated', LOCK_FILE])

export const WEBSITE_ROOT = path.resolve(import.meta.dirname, '..')
export const MONOREPO_ROOT = path.resolve(WEBSITE_ROOT, '../..')
export const SNAPSHOT_ROOT = path.join(WEBSITE_ROOT, '.lines')
const MARKER = '.materialized'
const DEV_FOLDER = 'preview'
const MONOREPO_URL = 'https://github.com/tetherto/qvac.git'

/** Where a line's materialized source comes from. */
export type LineSource =
  | { kind: 'commit'; sha: string; repo: string | null }
  | { kind: 'tree'; root: string }

export interface PlannedLine {
  software: VersionsFile
  /** The software's path without the leading slash: `sdk`, `ecosystem/packages/x`. */
  slug: string
  /** The line's version, or `preview` for the unreleased line. */
  version: string
  /** The folder under the software's content directory. */
  folder: string
  source: LineSource
}

export interface MaterializeOptions {
  overrides?: Readonly<Record<string, string>>
  includeDev?: boolean
  websiteRoot?: string
  monorepoRoot?: string
  files?: Readonly<Record<string, unknown>>
  /** Where monorepo commits missing locally are fetched from. */
  monorepoUrl?: string
  log?: (message: string) => void
}

/** Parses `<software>@<line>=<value>` into a map keyed by `<software>@<line>`. */
export function parseOverride(raw: string): [string, string] {
  const match = /^([a-z0-9/-]+)@(v\d+\.\d+)=(.+)$/.exec(raw)
  if (!match) {
    throw new Error(`--override expects <software>@<line>=<path|sha>, got '${raw}'`)
  }
  return [`${match[1]}@${match[2]}`, match[3]]
}

/** Every line to materialize, with where each comes from. */
export function planLines(options: MaterializeOptions = {}): PlannedLine[] {
  const monorepoRoot = options.monorepoRoot ?? MONOREPO_ROOT
  const overrides = { ...(options.overrides ?? {}) }
  const planned: PlannedLine[] = []

  for (const { declaration } of declaredSoftware(options.files)) {
    const slug = declaration.path.slice(1)
    declaration.lines.forEach((line, index) => {
      const key = `${slug}@${line.version}`
      const override = overrides[key]
      delete overrides[key]
      if (!override && !isPinnedLine(line)) return

      const current = index === 0
      const folder = current ? `(${line.version})` : line.version
      const source: LineSource = override
        ? resolveOverride(override, monorepoRoot, declaration.repo)
        : { kind: 'commit', sha: (line as { sha: string }).sha, repo: declaration.repo }
      planned.push({ software: declaration, slug, version: line.version, folder, source })
    })

    // The unreleased line exists only once the software keeps its
    // documentation in its package; until then there is nothing to preview.
    if (
      options.includeDev &&
      declaration.kind === 'product' &&
      declaration.repo === null &&
      existsSync(path.join(monorepoRoot, declaration.paths[0]))
    ) {
      planned.push({
        software: declaration,
        slug,
        version: DEV_FOLDER,
        folder: DEV_FOLDER,
        source: { kind: 'tree', root: monorepoRoot },
      })
    }
  }

  const unused = Object.keys(overrides)
  if (unused.length > 0) {
    throw new Error(`--override names undeclared lines: ${unused.join(', ')}`)
  }
  return planned
}

function resolveOverride(value: string, monorepoRoot: string, repo: string | null): LineSource {
  const asPath = path.resolve(monorepoRoot, value)
  if (existsSync(asPath)) return { kind: 'tree', root: asPath }
  if (/^[0-9a-f]{7,40}$/.test(value)) return { kind: 'commit', sha: value, repo }
  throw new Error(`--override value '${value}' is neither a directory nor a commit`)
}

/** Materializes every planned line and removes the ones no longer declared. */
export async function materializeLines(options: MaterializeOptions = {}): Promise<PlannedLine[]> {
  const websiteRoot = options.websiteRoot ?? WEBSITE_ROOT
  const monorepoRoot = options.monorepoRoot ?? MONOREPO_ROOT
  const log = options.log ?? ((message: string) => console.log(message))
  const planned = planLines(options)

  for (const line of planned) {
    const snapshot = path.join(websiteRoot, '.lines', line.slug, line.version)
    await extractSnapshot(line, snapshot, monorepoRoot, websiteRoot, options.monorepoUrl ?? MONOREPO_URL)
    await transpileExamples(snapshot)
    await publishPageTree(line, snapshot, websiteRoot)
    log(`materialized ${line.slug} ${line.folder} from ${describe(line.source)}`)
  }

  await removeStaleLines(planned, websiteRoot, log)
  return planned
}

function describe(source: LineSource): string {
  return source.kind === 'commit'
    ? `${source.repo ?? 'monorepo'}@${source.sha.slice(0, 12)}`
    : `working tree ${source.root}`
}

/** Extracts the line's declared paths into its snapshot directory. */
async function extractSnapshot(
  line: PlannedLine,
  snapshot: string,
  monorepoRoot: string,
  websiteRoot: string,
  monorepoUrl: string,
): Promise<void> {
  const stamp = path.join(snapshot, MARKER)
  if (line.source.kind === 'commit' && (await readText(stamp)) === line.source.sha) return

  await fs.rm(snapshot, { recursive: true, force: true })
  await fs.mkdir(snapshot, { recursive: true })
  const [docsRoot, ...others] = line.software.paths

  if (line.source.kind === 'tree') {
    const root = line.source.root
    if (!existsSync(path.join(root, docsRoot))) {
      throw new Error(`${line.slug} ${line.version}: ${docsRoot} does not exist in ${root}`)
    }
    for (const relative of line.software.paths) {
      const from = path.join(root, relative)
      if (existsSync(from)) await fs.cp(from, path.join(snapshot, relative), { recursive: true })
    }
    return
  }

  const gitDir = await ensureCommit(line.source, monorepoRoot, websiteRoot, line, monorepoUrl)
  if (!pathExistsAt(gitDir, line.source.sha, docsRoot)) {
    throw new Error(
      `${line.slug} ${line.version} is pinned to ${line.source.sha}, which has no ${docsRoot}`,
    )
  }
  for (const relative of [docsRoot, ...others]) {
    if (!pathExistsAt(gitDir, line.source.sha, relative)) continue
    const archive = spawnSync('git', ['-C', gitDir, 'archive', '--format=tar', line.source.sha, '--', relative], {
      maxBuffer: 1024 * 1024 * 1024,
    })
    if (archive.status !== 0) {
      throw new Error(`git archive failed for ${line.slug} ${line.version}: ${archive.stderr}`)
    }
    const untar = spawnSync('tar', ['-x', '-C', snapshot], { input: archive.stdout })
    if (untar.status !== 0) throw new Error(`tar failed for ${line.slug} ${line.version}: ${untar.stderr}`)
  }
  await fs.writeFile(stamp, line.source.sha)
}

/**
 * The git directory holding the line's commit, fetching it when absent. The
 * monorepo's own clone serves monorepo lines; another repository is fetched
 * into a cache under `.lines/.repos/`.
 */
async function ensureCommit(
  source: Extract<LineSource, { kind: 'commit' }>,
  monorepoRoot: string,
  websiteRoot: string,
  line: PlannedLine,
  monorepoUrl: string,
): Promise<string> {
  let gitDir = monorepoRoot
  let url = monorepoUrl
  if (source.repo) {
    gitDir = path.join(websiteRoot, '.lines', '.repos', source.repo.replace('/', '__'))
    url = `https://github.com/${source.repo}.git`
    if (!existsSync(gitDir)) {
      await fs.mkdir(gitDir, { recursive: true })
      execFileSync('git', ['init', '--bare', '--quiet', gitDir])
    }
  }
  if (hasCommit(gitDir, source.sha)) return gitDir
  const fetch = spawnSync('git', ['-C', gitDir, 'fetch', '--quiet', '--depth=1', url, source.sha], {
    encoding: 'utf-8',
  })
  if (fetch.status !== 0 || !hasCommit(gitDir, source.sha)) {
    throw new Error(
      `${line.slug} ${line.version}: commit ${source.sha} cannot be fetched from ${url}\n${fetch.stderr ?? ''}`,
    )
  }
  return gitDir
}

function hasCommit(gitDir: string, sha: string): boolean {
  return spawnSync('git', ['-C', gitDir, 'cat-file', '-e', `${sha}^{commit}`]).status === 0
}

function pathExistsAt(gitDir: string, sha: string, relative: string): boolean {
  return spawnSync('git', ['-C', gitDir, 'cat-file', '-e', `${sha}:${relative}`]).status === 0
}

/**
 * Transpiles every `packages/<pkg>/examples` tree in the snapshot that holds
 * TypeScript into `packages/<pkg>/dist/examples`, and copies its companion
 * data files beside the output, as `prebuild:examples` does for `main`.
 */
async function transpileExamples(snapshot: string): Promise<void> {
  const packagesDir = path.join(snapshot, 'packages')
  if (!existsSync(packagesDir)) return
  for (const pkg of await fs.readdir(packagesDir)) {
    const examples = path.join(packagesDir, pkg, 'examples')
    const sources = existsSync(examples) ? await filesUnder(examples, (file) => file.endsWith('.ts')) : []
    if (sources.length === 0) continue
    const outDir = path.join(packagesDir, pkg, 'dist', 'examples')
    const tsc = spawnSync(
      'npx',
      ['tsc', '--noCheck', '--noResolve', '--skipLibCheck', '--module', 'ESNext', '--target', 'ESNext',
        '--rootDir', examples, '--outDir', outDir, ...sources],
      { cwd: WEBSITE_ROOT, encoding: 'utf-8' },
    )
    if (tsc.status !== 0) throw new Error(`transpiling ${examples} failed:\n${tsc.stdout}${tsc.stderr}`)
    const assets = await filesUnder(examples, (file) => !/\.(ts|js|md)$/.test(file))
    for (const asset of assets) {
      const target = path.join(outDir, path.relative(examples, asset))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(asset, target)
    }
  }
}

/** Copies the line's documentation root to its folder under `content/docs/`. */
async function publishPageTree(line: PlannedLine, snapshot: string, websiteRoot: string): Promise<void> {
  const softwareDir = path.join(websiteRoot, 'content', 'docs', line.slug)
  const target = path.join(softwareDir, line.folder)

  // The same version may have been materialized under its other folder name
  // when currency moved; remove that one too.
  const version = line.folder.replace(/^\((.*)\)$/, '$1')
  for (const candidate of new Set([line.folder, version, `(${version})`])) {
    const existing = path.join(softwareDir, candidate)
    const entry = await fs.lstat(existing).catch(() => null)
    if (!entry) continue
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${path.relative(websiteRoot, existing)} is a symbolic link, probably the old manual ` +
          `preview: remove it, the materializer writes that folder itself`,
      )
    }
    if (!existsSync(path.join(existing, MARKER))) {
      throw new Error(
        `${path.relative(websiteRoot, existing)} exists and was not materialized: ` +
          `remove it, or declare ${line.slug} ${version} in place`,
      )
    }
    await fs.rm(existing, { recursive: true, force: true })
  }

  await fs.mkdir(softwareDir, { recursive: true })
  // Generated data stays in the snapshot, where the data components read it,
  // and the bindings lock stays with the package's checks: the page tree
  // carries pages and navigation only.
  const docsRoot = path.join(snapshot, line.software.paths[0])
  await fs.cp(docsRoot, target, {
    recursive: true,
    filter: (source) => !SNAPSHOT_ONLY.has(path.relative(docsRoot, source).split(path.sep)[0]),
  })
  await fs.writeFile(path.join(target, MARKER), describe(line.source))
  await fs.writeFile(path.join(target, '.gitignore'), '*\n')
}

/** Removes every materialized folder whose line is no longer planned. */
async function removeStaleLines(
  planned: readonly PlannedLine[],
  websiteRoot: string,
  log: (message: string) => void,
): Promise<void> {
  const contentRoot = path.join(websiteRoot, 'content', 'docs')
  const keep = new Set(planned.map((line) => path.join(contentRoot, line.slug, line.folder)))
  for (const marker of await filesUnder(contentRoot, (file) => path.basename(file) === MARKER)) {
    const folder = path.dirname(marker)
    if (keep.has(folder)) continue
    await fs.rm(folder, { recursive: true, force: true })
    log(`removed stale ${path.relative(contentRoot, folder)}`)
  }
}

async function filesUnder(dir: string, keep: (file: string) => boolean): Promise<string[]> {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await filesUnder(entryPath, keep)))
    else if (entry.isFile() && keep(entryPath)) found.push(entryPath)
  }
  return found
}

async function readText(file: string): Promise<string | null> {
  try {
    return (await fs.readFile(file, 'utf-8')).trim()
  } catch {
    return null
  }
}

if (import.meta.main) {
  // `DOCS_MATERIALIZE_FLAGS` carries the same flags through `npm run build`,
  // which materializes before building: pull-request checks set it.
  const args = [...process.argv.slice(2), ...(process.env.DOCS_MATERIALIZE_FLAGS ?? '').split(/\s+/).filter(Boolean)]
  const overrides: Record<string, string> = {}
  let includeDev = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--include-dev') includeDev = true
    else if (arg === '--override') {
      const [key, value] = parseOverride(args[++index] ?? '')
      overrides[key] = value
    } else if (arg.startsWith('--override=')) {
      const [key, value] = parseOverride(arg.slice('--override='.length))
      overrides[key] = value
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  materializeLines({ overrides, includeDev }).catch((error: Error) => {
    console.error(error.message)
    process.exit(1)
  })
}
