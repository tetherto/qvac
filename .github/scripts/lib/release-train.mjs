// Release trains: nx release groups that publish together from one
// release-train-<train>-<x.y.z> branch. Group membership lives in nx.json;
// .github/release-trains.json says which groups form a train, which group's
// version names the branch, which package gets the GitHub release, and which
// checks must pass before and after publishing.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export const BRANCH_PATTERN = /^release-train-([a-z0-9][a-z0-9-]*)-(\d+\.\d+\.\d+)$/

// Each kind is a job in release-train.yml; a train lists the ones it requires.
export const CHECK_KINDS = ['shared-runtime-libs', 'sdk-python', 'package-checks']

export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

export function readRepoJson (path) {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8'))
}

export function parseBranch (ref) {
  const match = BRANCH_PATTERN.exec(ref)
  return match && { train: match[1], version: match[2] }
}

export function loadTrain (name, catalog, nxJson) {
  const train = catalog[name]
  if (!train) {
    throw new Error(`Unknown release train '${name}'. Known trains: ${Object.keys(catalog).join(', ')}`)
  }
  const groups = nxJson.release?.groups ?? {}
  for (const group of train.groups) {
    if (!groups[group]) throw new Error(`Train '${name}' names release group '${group}', which nx.json does not declare`)
    const other = Object.keys(catalog).find((n) => n !== name && catalog[n].groups.includes(group))
    if (other) throw new Error(`Release group '${group}' is in both '${name}' and '${other}'`)
  }
  // The branch carries one version for the anchor group, so its members must share it.
  if (!train.groups.includes(train.anchorGroup) || groups[train.anchorGroup].projectsRelationship !== 'fixed') {
    throw new Error(`Train '${name}': anchorGroup '${train.anchorGroup}' must be one of its groups and "fixed"`)
  }
  const projects = train.groups.flatMap((group) => groups[group].projects)
  if (train.githubRelease && !projects.includes(train.githubRelease.project)) {
    throw new Error(`Train '${name}': githubRelease project ${train.githubRelease.project} is not in the train`)
  }
  const checks = train.checks ?? []
  const unknown = checks.filter((check) => !CHECK_KINDS.includes(check))
  if (unknown.length) {
    throw new Error(`Train '${name}': unknown checks ${unknown.join(', ')}; known: ${CHECK_KINDS.join(', ')}`)
  }
  if (checks.includes('package-checks') && !train.packageChecks) {
    throw new Error(`Train '${name}': package-checks needs packageChecks, the per-package check config`)
  }
  return {
    name,
    projects,
    anchorProjects: groups[train.anchorGroup].projects,
    githubRelease: train.githubRelease ?? null,
    checks,
    packageChecks: train.packageChecks ?? null,
  }
}

export function slugOf (name) {
  return name.replace(/^@[^/]+\//, '')
}

export function tagFor (name, version) {
  return `${slugOf(name)}-v${version}`
}

export function movedProjects (projects, versionAt) {
  return projects
    .map((project) => ({ ...project, version: versionAt.head(project), from: versionAt.base(project) }))
    .filter((project) => project.version !== project.from)
    .map(({ name, dir, version }) => ({ name, slug: slugOf(name), dir, version }))
}

export function changelogSection (changelog, version) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## ['))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()
}

function parseVersion (version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return match && match.slice(1).map(Number)
}

export function compareVersions (a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

// Train ranges are exact, ^ or ~ on a plain x.y.z; anything else is reported
// rather than guessed at. Returns null for an unsupported range.
export function satisfies (version, range) {
  const match = /^([~^]?)(\d+\.\d+\.\d+)$/.exec(range.trim())
  if (!match || !parseVersion(version)) return null
  const [op, base] = [match[1], match[2]]
  const [major, minor] = parseVersion(base)
  const [vMajor, vMinor] = parseVersion(version)
  if (compareVersions(version, base) < 0) return false
  if (op === '') return version === base
  if (op === '~' || (op === '^' && major === 0 && minor === 0)) {
    return op === '~' ? vMajor === major && vMinor === minor : version === base
  }
  if (op === '^' && major === 0) return vMajor === 0 && vMinor === minor
  return vMajor === major
}

// Every range between train packages must accept the version this train moves
// the target to, or consumers of the train keep resolving the old one.
export function rangeErrors (manifests, versions) {
  const errors = []
  for (const [name, manifest] of Object.entries(manifests)) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (!(dep in versions) || dep === name) continue
        const ok = satisfies(versions[dep], range)
        if (ok === null) errors.push(`${name} ${field}: ${dep}@"${range}" is not an exact, ^ or ~ range`)
        else if (!ok) errors.push(`${name} ${field}: ${dep}@"${range}" does not accept ${versions[dep]}`)
      }
    }
  }
  return errors
}

export function checkRelease ({ branch, train, moved, versionAtHead, changelogAt, versionPlans = [], manifests }) {
  // nx applies every plan file on disk, so a committed plan would bump the
  // next train again.
  const errors = versionPlans.map((path) => `${path} is committed; delete it, nx would apply it again`)
  for (const project of train.anchorProjects) {
    const version = versionAtHead(project)
    if (version !== branch.version) {
      errors.push(`${project} is at ${version}, the branch says ${branch.version}`)
    }
  }
  const movedNames = new Set(moved.map((project) => project.name))
  for (const name of train.projects) {
    if (!movedNames.has(name)) errors.push(`${name} does not move; a train releases every package in it`)
  }
  for (const project of moved) {
    if (!changelogSection(changelogAt(project) ?? '', project.version)) {
      errors.push(`${project.dir}/CHANGELOG.md has no notes under "## [${project.version}]"`)
    }
  }
  const versions = Object.fromEntries(train.projects.map((name) => [name, versionAtHead(name)]))
  errors.push(...rangeErrors(manifests, versions))
  return errors
}

// A version on npm was published from the commit in its gitHead. Publishing the
// rest of the train from another commit would mix sources in one release.
export function publishedElsewhere (moved, gitHeadOf, head) {
  const errors = []
  for (const project of moved) {
    const gitHead = gitHeadOf(project)
    if (gitHead && gitHead !== head) {
      errors.push(`${project.name}@${project.version} was published from ${gitHead}, not ${head}; cut a new train branch`)
    }
  }
  return errors
}

// A consumer install that resolves every train package from its tarball, as it
// will from npm once published. npm rejects an override that differs from a
// direct dependency, so direct dependencies point at the same tarball.
export function stageManifest (manifest, allTarballs) {
  const tarballs = Object.fromEntries(Object.entries(allTarballs).filter(([dep]) => dep !== manifest.name))
  const staged = structuredClone(manifest)
  for (const field of DEPENDENCY_FIELDS) {
    for (const dep of Object.keys(staged[field] ?? {})) {
      if (tarballs[dep]) staged[field][dep] = `file:${tarballs[dep]}`
    }
  }
  staged.overrides = { ...staged.overrides, ...Object.fromEntries(Object.entries(tarballs).map(([dep, path]) => [dep, `file:${path}`])) }
  return staged
}

// `git ls-remote --tags origin <tag> <tag>^{}`: an annotated tag lists its tag
// object, then the commit it points at under ^{}.
export function parseLsRemote (output, tag) {
  let direct = null
  for (const line of output.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (ref === `refs/tags/${tag}^{}`) return sha
    if (ref === `refs/tags/${tag}`) direct = sha
  }
  return direct
}

// Each tag goes on the commit npm records as the version's gitHead.
export function planTags (moved, { releaseProject, remoteCommit, gitHeadOf }) {
  const plan = { create: [], existing: [], conflicts: [] }
  for (const project of moved) {
    // create-github-release.yml makes this one.
    if (project.name === releaseProject) continue
    const tag = tagFor(project.name, project.version)
    const target = gitHeadOf(project)
    const commit = remoteCommit(tag)
    if (commit === null) plan.create.push({ tag, commit: target })
    else if (commit === target) plan.existing.push(tag)
    else plan.conflicts.push({ tag, commit, expected: target })
  }
  return plan
}

// pnpm links a workspace sibling whenever its version satisfies the range, so
// the build can compile against a version npm does not have yet.
export function linkedOutsideTrain (projects, resolvedDeps) {
  const inTrain = new Set(projects)
  const linked = new Map()
  for (const project of projects) {
    for (const dep of resolvedDeps(project)) {
      if (inTrain.has(dep.name) || !dep.version.startsWith('link:')) continue
      if (!linked.has(dep.name)) linked.set(dep.name, { name: dep.name, dependents: [] })
      linked.get(dep.name).dependents.push(project)
    }
  }
  return [...linked.values()].sort((a, b) => a.name.localeCompare(b.name))
}
