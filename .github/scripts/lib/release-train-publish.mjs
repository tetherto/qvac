/**
 * Publishes a release train to npm, one package per nx call.
 *
 * Why not `nx release publish`:
 * - Without a filter it publishes every release group in nx.json, and its
 *   `^nx-release-publish` task dependencies run the publish executor for every
 *   workspace package the train depends on (addons, rag, test-suite): a
 *   dist-tag move, or a publish from source, for each one whose npm state
 *   differs from the branch. An empty `--projects=` is no filter.
 * - With `--projects` or `--groups` it runs each release group as its own task
 *   run, drops the waits between groups, and starts the next group after one
 *   fails, so cli would still publish after sdk failed. It also refuses to
 *   publish one member of a fixed group on its own.
 *
 * `nx run-many -t nx-release-publish --projects=<one name>
 * --exclude-task-dependencies` runs the same executor for exactly the named
 * package. The order and the stop on the first failure are decided here.
 */
import { trainProjects } from './release-trains.mjs'

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']

/**
 * The train's packages with their manifests, in an order where every package
 * comes after the train packages it depends on. Catalog order breaks ties.
 */
export function planPublish (train, readManifest, catalog) {
  const projects = trainProjects(train, catalog)
  if (projects.length === 0) {
    throw new Error(`Release train '${train}' has no projects to publish`)
  }

  const entries = projects.map((project) => {
    const manifest = JSON.parse(readManifest(`${project.dir}/package.json`))
    if (manifest.name !== project.name) {
      throw new Error(`${project.dir}/package.json is ${manifest.name}, the catalog says ${project.name}`)
    }
    if (manifest.private === true) {
      throw new Error(`${project.name} is private and cannot be published`)
    }
    if (!manifest.version) {
      throw new Error(`${project.name} has no version`)
    }
    return { name: project.name, dir: project.dir, version: manifest.version, manifest }
  })

  const names = new Set(entries.map((e) => e.name))
  const waitsOn = new Map(entries.map((e) => [
    e.name,
    new Set(DEPENDENCY_FIELDS.flatMap((field) => Object.keys(e.manifest[field] ?? {}))
      .filter((dep) => dep !== e.name && names.has(dep)))
  ]))

  const ordered = []
  const remaining = [...entries]
  while (remaining.length > 0) {
    const index = remaining.findIndex((e) => [...waitsOn.get(e.name)].every((dep) => ordered.some((o) => o.name === dep)))
    if (index === -1) {
      throw new Error(`Dependency cycle between ${remaining.map((e) => e.name).join(', ')}`)
    }
    const [next] = remaining.splice(index, 1)
    ordered.push({ name: next.name, dir: next.dir, version: next.version })
  }
  return ordered
}

/**
 * The dist-tag rule of tetherto/qvac-actions npm-dist-tag-determination, so a
 * train and a single-package release tag the same version the same way: an
 * explicit tag other than "latest" is used as given; otherwise a stable
 * version at or above npm's `latest` gets `latest`, and anything else gets
 * `release-<major>.<minor>`.
 */
export function resolveDistTag ({ version, latest, requested }) {
  if (requested && requested !== 'latest') return requested
  const core = (v) => v.replace(/^v/, '').split('-')[0].split('.').map(Number)
  const [a, b, c] = core(version)
  const [x, y, z] = core(latest || '0.0.0')
  const atOrAbove = (a - x || b - y || c - z) >= 0
  return !version.includes('-') && atOrAbove ? 'latest' : `release-${a}.${b}`
}

/** npm's current `latest` for a package; 0.0.0 when it was never published. */
export function readLatest (name, run) {
  const result = run('npm', ['view', name, 'dist-tags.latest', '--json'])
  if (result.status !== 0) {
    let code
    try {
      code = JSON.parse(result.stdout).error?.code
    } catch {}
    if (code === 'E404') return '0.0.0'
    throw new Error(`npm view ${name} failed (exit ${result.status}): ${result.stderr || result.stdout}`)
  }
  const out = result.stdout.trim()
  return out ? JSON.parse(out) : '0.0.0'
}

/**
 * Resolves every tag first, so a registry error stops the run before anything
 * is published, then publishes in dependency order and stops at the first
 * failure. Re-running publishes the rest: the executor skips a version
 * already on npm under the same tag.
 */
export function publishTrain ({ train, requestedTag = '', dryRun = false, readManifest, run, log = console.log, catalog }) {
  const plan = planPublish(train, readManifest, catalog).map((entry) => ({
    ...entry,
    tag: resolveDistTag({ version: entry.version, latest: readLatest(entry.name, run), requested: requestedTag })
  }))

  for (const entry of plan) {
    log(`${entry.name}@${entry.version} -> ${entry.tag}`)
  }

  const published = []
  for (const [index, entry] of plan.entries()) {
    const args = [
      'exec', 'nx', 'run-many', '-t', 'nx-release-publish',
      `--projects=${entry.name}`, '--exclude-task-dependencies', `--tag=${entry.tag}`,
    ]
    if (dryRun) args.push('--dry-run')
    const result = run('pnpm', args, { stdio: 'inherit' })
    if (result.status !== 0) {
      return {
        published,
        failed: entry,
        notAttempted: plan.slice(index + 1)
      }
    }
    published.push(entry)
  }
  return { published, failed: null, notAttempted: [] }
}
