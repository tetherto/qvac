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
 * @param {string} baseSha    previous tip; empty or all-zero on branch creation
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

  // Initial branch push has no diff to inspect.
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

export { parseBranch, trainNames }
