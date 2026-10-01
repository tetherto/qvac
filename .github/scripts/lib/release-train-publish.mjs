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

/**
 * `npm view <spec> <field> --json`; null when npm answers E404, which it does
 * both for a package never published and for a version it does not have.
 * `--prefer-online` revalidates npm's metadata cache, which would otherwise
 * answer a just-published version with a cached 404.
 */
function npmView (spec, field, run) {
  const result = run('npm', ['view', spec, field, '--json', '--prefer-online'])
  if (result.status !== 0) {
    let code
    try {
      code = JSON.parse(result.stdout).error?.code
    } catch {}
    if (code === 'E404') return null
    throw new Error(`npm view ${spec} failed (exit ${result.status}): ${result.stderr || result.stdout}`)
  }
  const out = result.stdout.trim()
  return out ? JSON.parse(out) : null
}

/** npm's current `latest` for a package; 0.0.0 when it was never published. */
export function readLatest (name, run) {
  return npmView(name, 'dist-tags.latest', run) ?? '0.0.0'
}

/** Whether npm already has this exact version. */
export function isPublished (name, version, run) {
  return npmView(`${name}@${version}`, 'version', run) !== null
}

function sleepSync (ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export const SERVE_WAIT = { attempts: 30, intervalMs: 10_000 }

/**
 * Polls npm until it serves `name@version`. A publish returns once npm accepts
 * the upload, which can be before its metadata answers for the version; a
 * dependent published in that window can be installed while its dependency
 * does not resolve.
 */
export function waitUntilServed (name, version, run, { attempts, intervalMs } = SERVE_WAIT, sleep = sleepSync, log = console.log) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (isPublished(name, version, run)) return true
    } catch (error) {
      // A 5xx or a timeout is the registry being unavailable, which is what
      // this loop already waits out. Throwing here would leave the job with no
      // shipped / not-attempted report.
      log(`${name}@${version}: ${error.message}; treating as not yet served`)
    }
    if (attempt < attempts) sleep(intervalMs)
  }
  return false
}

/**
 * Reads every tag and whether each version is already on npm first, so a
 * registry error stops the run before anything is published, then publishes
 * in dependency order. After each publish it waits until npm serves the new
 * version before publishing the next package, and stops at the first failure
 * or timeout. Re-running publishes the rest: the executor skips a version
 * already on npm under the same tag. `alreadyPublished` is read before the
 * executor runs, so the report can say which versions this run added.
 */
export function publishTrain ({ train, requestedTag = '', dryRun = false, readManifest, run, log = console.log, catalog, serveWait = SERVE_WAIT, sleep = sleepSync }) {
  const plan = planPublish(train, readManifest, catalog).map((entry) => ({
    ...entry,
    tag: resolveDistTag({ version: entry.version, latest: readLatest(entry.name, run), requested: requestedTag }),
    alreadyPublished: isPublished(entry.name, entry.version, run)
  }))

  for (const entry of plan) {
    log(`${entry.name}@${entry.version} -> ${entry.tag}${entry.alreadyPublished ? ' (already on npm)' : ''}`)
  }

  const completed = []
  for (const [index, entry] of plan.entries()) {
    const args = [
      'exec', 'nx', 'run-many', '-t', 'nx-release-publish',
      `--projects=${entry.name}`, '--exclude-task-dependencies', `--tag=${entry.tag}`,
    ]
    if (dryRun) args.push('--dry-run')
    const result = run('pnpm', args, { stdio: 'inherit' })
    const failure = result.status !== 0
      ? 'publish'
      : !dryRun && !entry.alreadyPublished && !waitUntilServed(entry.name, entry.version, run, serveWait, sleep)
          ? 'not-served'
          : null
    if (failure) {
      return {
        completed,
        failed: { ...entry, reason: failure },
        notAttempted: plan.slice(index + 1)
      }
    }
    completed.push(entry)
  }
  return { completed, failed: null, notAttempted: [] }
}
