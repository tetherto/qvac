/**
 * Which <slug>-v<version> tags a train run creates, decided against origin.
 *
 * The checkout's tags are a snapshot, so the decision reads origin: a tag
 * already there at this commit is left alone, which keeps a re-run of a
 * half-shipped train green; a tag there at a different commit fails the run,
 * as create-release-tag.yml does, instead of being skipped.
 */
import { tagFor } from './release-trains.mjs'

/**
 * The commit a tag points at, from `git ls-remote --tags origin <tag> <tag>^{}`
 * output, or null when origin has no such tag. An annotated tag lists its tag
 * object and then, with `^{}`, the commit it points at.
 */
export function parseLsRemote (output, tag) {
  let direct = null
  for (const line of output.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (ref === `refs/tags/${tag}^{}`) return sha
    if (ref === `refs/tags/${tag}`) direct = sha
  }
  return direct
}

/**
 * @param {Array<{slug: string, dir: string, viaRelease: boolean}>} targets
 * @param {object} io
 * @param {(dir: string) => string} io.versionOf   version in <dir>/package.json
 * @param {(tag: string) => string | null} io.remoteCommit   commit the tag points at on origin
 * @param {string} io.head   commit being tagged
 */
export function planTags (targets, { versionOf, remoteCommit, head }) {
  const plan = { create: [], existing: [], viaRelease: [], conflicts: [] }
  for (const target of targets) {
    if (target.viaRelease) {
      plan.viaRelease.push(target.slug)
      continue
    }
    const tag = tagFor(target, versionOf(target.dir))
    const commit = remoteCommit(tag)
    if (commit === null) plan.create.push(tag)
    else if (commit === head) plan.existing.push(tag)
    else plan.conflicts.push({ tag, commit })
  }
  return plan
}
