// Release trains: nx release groups that publish together from one
// release-train-<train>-<x.y.z> branch. Group membership lives in nx.json;
// .github/release-trains.json says which groups form a train, which group's
// version names the branch, and which package gets the GitHub release.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export const BRANCH_PATTERN = /^release-train-([a-z0-9][a-z0-9-]*)-(\d+\.\d+\.\d+)$/

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
  return {
    name,
    projects,
    anchorProjects: groups[train.anchorGroup].projects,
    githubRelease: train.githubRelease ?? null,
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

// Everything nx counts as affected since the last train release must move in
// this one: the train releases its packages as a set.
export function checkRelease ({ branch, train, moved, versionAtHead, changelogAt, affected, versionPlans = [] }) {
  // nx applies every plan file on disk, so a committed plan would bump the
  // next train again.
  const errors = versionPlans.map((path) => `${path} is committed; delete it, nx would apply it again`)
  for (const project of train.anchorProjects) {
    const version = versionAtHead(project)
    if (version !== branch.version) {
      errors.push(`${project} is at ${version}, the branch says ${branch.version}`)
    }
  }
  for (const project of moved) {
    if (!changelogSection(changelogAt(project) ?? '', project.version)) {
      errors.push(`${project.dir}/CHANGELOG.md has no notes under "## [${project.version}]"`)
    }
  }
  const movedNames = new Set(moved.map((project) => project.name))
  for (const name of train.projects) {
    if (affected.includes(name) && !movedNames.has(name)) {
      errors.push(`${name} changed since the last train release but this release does not move it`)
    }
  }
  return errors
}

// The rule of tetherto/qvac-actions npm-dist-tag-determination, so a train and
// a single-package release tag a version the same way.
export function resolveDistTag ({ version, latest, requested }) {
  if (requested && requested !== 'latest') return requested
  const core = (v) => v.split('-')[0].split('.').map(Number)
  const [a, b, c] = core(version)
  const [x, y, z] = core(latest || '0.0.0')
  return !version.includes('-') && (a - x || b - y || c - z) >= 0 ? 'latest' : `release-${a}.${b}`
}

// One nx run publishes the train, and nx takes one --tag for all of it.
export function singleDistTag (entries) {
  const tags = new Set(entries.map((entry) => entry.tag))
  if (tags.size > 1) {
    const detail = entries.map((entry) => `${entry.name}@${entry.version} -> ${entry.tag}`).join(', ')
    throw new Error(`The moved packages resolve to different dist-tags (${detail}); pass npm_tag to choose one`)
  }
  return [...tags][0]
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

export function planTags (moved, { releaseProject, remoteCommit, head }) {
  const plan = { create: [], existing: [], conflicts: [] }
  for (const project of moved) {
    // create-github-release.yml makes this one.
    if (project.name === releaseProject) continue
    const tag = tagFor(project.name, project.version)
    const commit = remoteCommit(tag)
    if (commit === null) plan.create.push(tag)
    else if (commit === head) plan.existing.push(tag)
    else plan.conflicts.push({ tag, commit })
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
