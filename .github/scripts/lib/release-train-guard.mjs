/**
 * Checks a release train branch describes what it carries.
 *
 * What a train contains comes from .github/release-trains.json, never from a
 * list here — see .github/scripts/lib/release-trains.mjs.
 *
 * The per-package guard (.github/actions/release-merge-guard) compares one
 * branch version against one package.json. A train moves every package in it
 * at once, on their own numbers, so that comparison has nothing to anchor to.
 * What anchors here is the train's `anchorGroup`: a fixed group releases in
 * lockstep, so its version is the one number that describes the train, and the
 * branch carries it.
 */
import { getTrain, parseBranch, trainNames, trainProjects } from './release-trains.mjs'

const ZERO_SHA = '0000000000000000000000000000000000000000'

function majorMinor (version) {
  const parts = version.split('.')
  return `${parts[0]}.${parts[1]}`
}

/**
 * @param {string} ref        branch being pushed
 * @param {string} baseSha    what the branch is measured against, normally its
 *   merge base with the default branch. Callers pass that rather than the
 *   previous tip so a freshly created branch is checked too; empty or all-zero
 *   when no base could be resolved at all, which skips the changelog check.
 * @param {object} io
 * @param {(path: string) => string} io.readManifest   package.json at head
 * @param {() => string[]} io.changedFiles             paths changed in this push
 * @param {object} [catalog]  parsed release-trains.json, for tests
 */
export function checkReleaseTrain (ref, baseSha, io, catalog) {
  const errors = []
  const parsed = parseBranch(ref)

  if (!parsed) {
    errors.push(
      `Invalid release train branch name — expected release-train-<train>-x.y.z, actual: ${ref}`
    )
    return errors
  }

  let train
  try {
    train = getTrain(parsed.train, catalog)
  } catch (err) {
    errors.push(err.message)
    return errors
  }

  const anchor = train.groups[train.anchorGroup]
  if (!anchor) {
    errors.push(
      `Train '${parsed.train}' names anchorGroup '${train.anchorGroup}', which it does not declare`
    )
    return errors
  }

  const versions = new Map()
  for (const project of trainProjects(parsed.train, catalog)) {
    const manifestPath = `${project.dir}/package.json`
    try {
      versions.set(project.slug, JSON.parse(io.readManifest(manifestPath)).version)
    } catch (err) {
      errors.push(`Could not read ${manifestPath}: ${err.message}`)
    }
  }

  // The branch names the anchor group's version, and a fixed group releases in
  // lockstep, so every member must be at it.
  for (const project of anchor.projects) {
    const version = versions.get(project.slug)
    if (version && version !== parsed.version) {
      errors.push(
        `Anchor version mismatch — branch says ${parsed.version}, ${project.slug} package.json says ${version}`
      )
    }
  }

  // Independent of the branch: a fixed group shipped apart only fails later and
  // louder, in whatever lint the group exists to satisfy.
  const anchorVersions = anchor.projects
    .map((p) => ({ slug: p.slug, version: versions.get(p.slug) }))
    .filter((v) => v.version)
  const spread = new Set(anchorVersions.map((v) => majorMinor(v.version)))
  if (spread.size > 1) {
    const detail = anchorVersions.map((v) => `${v.slug} ${v.version}`).join(', ')
    errors.push(`Group '${train.anchorGroup}' must share a major and minor — ${detail}`)
  }

  // No base at all, so there is no diff to inspect. Callers resolve a merge
  // base rather than relying on the previous tip, so this is the unresolvable
  // case and not an ordinary first push.
  if (!baseSha || baseSha === ZERO_SHA) {
    return errors
  }

  // A package that moved must say why it moved. Ones the cascade did not reach
  // are not in this release and are not asked for a changelog.
  const changed = new Set(io.changedFiles())
  for (const project of trainProjects(parsed.train, catalog)) {
    const manifestPath = `${project.dir}/package.json`
    if (!changed.has(manifestPath)) continue
    const changelogPath = `${project.dir}/CHANGELOG.md`
    if (!changed.has(changelogPath)) {
      errors.push(
        `${project.slug} changed version but not its changelog — ${changelogPath} is untouched`
      )
    }
  }

  return errors
}

/**
 * Train projects whose version differs between two commits, with the version
 * each one moved to, so a caller can check that version's changelog section.
 *
 * @param {(sha: string, path: string) => string | null} readManifestAt
 *   package.json at a commit, or null when the file does not exist there
 */
export function movedProjects (ref, baseSha, headSha, readManifestAt, catalog) {
  const parsed = parseBranch(ref)
  if (!parsed) {
    throw new Error(`Not a release train branch: ${ref}`)
  }
  const moved = []
  for (const project of trainProjects(parsed.train, catalog)) {
    const manifestPath = `${project.dir}/package.json`
    const head = readManifestAt(headSha, manifestPath)
    if (head === null) {
      throw new Error(`${manifestPath} does not exist at ${headSha}`)
    }
    const headVersion = JSON.parse(head).version
    const base = readManifestAt(baseSha, manifestPath)
    const baseVersion = base === null ? null : JSON.parse(base).version
    if (headVersion !== baseVersion) {
      moved.push({ name: project.name, slug: project.slug, dir: project.dir, version: headVersion, changelog: `${project.dir}/CHANGELOG.md` })
    }
  }
  return moved
}

/**
 * The moved packages whose new version npm already has. The publish step skips
 * a version npm already has, so the train would ship without that package's
 * changes while its changelog and tag describe them.
 *
 * @param {Array<{ name: string, version: string }>} moved   from movedProjects
 * @param {(name: string, version: string) => boolean} isPublished
 */
export function alreadyOnNpm (moved, isPublished) {
  return moved.filter((project) => isPublished(project.name, project.version))
}

export { parseBranch, trainNames }
