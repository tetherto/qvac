/**
 * The release train catalog, and everything derived from it.
 *
 * A train is a set of packages that release together because they depend on
 * each other in a line. `.github/release-trains.json` is the only place that
 * list lives: nx.json's release block is generated from it, the release
 * workflow asks it which projects to build, and the merge guard asks it what
 * a branch should contain.
 *
 * A train is not a team's package roster. The SDK pod (.github/teams/sdk.json)
 * also owns registry-server, rag, logging, error and test-suite, which release
 * on their own and appear in no train.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const CATALOG = '.github/release-trains.json'
export const NX_JSON = 'nx.json'

/** release-train-<train>-<x.y.z> */
export const BRANCH_PATTERN = /^release-train-([a-z0-9][a-z0-9-]*)-(\d+\.\d+\.\d+)$/

export function readRepoFile (relativePath) {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

export function loadCatalog () {
  return JSON.parse(readRepoFile(CATALOG))
}

export function trainNames (catalog = loadCatalog()) {
  return Object.keys(catalog.trains)
}

export function getTrain (name, catalog = loadCatalog()) {
  const train = catalog.trains[name]
  if (!train) {
    throw new Error(
      `Unknown release train '${name}'. Known trains: ${trainNames(catalog).join(', ')}`
    )
  }
  return train
}

/** Every project in a train, in catalog order. */
export function trainProjects (name, catalog = loadCatalog()) {
  const train = getTrain(name, catalog)
  return Object.values(train.groups).flatMap((group) => group.projects)
}

/**
 * Parse a release train branch into { train, version }, or null when the ref
 * is not one. Returns null for an unknown train name so callers can report it
 * themselves.
 */
export function parseBranch (ref) {
  const match = BRANCH_PATTERN.exec(ref)
  if (!match) return null
  return { train: match[1], version: match[2] }
}

/** The tag a project gets once its publish succeeds. */
export function tagFor (project, version) {
  return `${project.slug}-v${version}`
}

/**
 * What a train produces after publishing: tags, an optional GitHub release,
 * and the assets attached to it. `uses:` must be a literal in a workflow, so
 * the catalog says what each project gets and release-train.yml holds one job
 * per kind, gated on this.
 */
export function postPublishPlan (name, catalog = loadCatalog()) {
  const tags = []
  let githubRelease = null

  for (const project of trainProjects(name, catalog)) {
    const post = project.postPublish ?? {}
    // A GitHub release carries its own tag, so it is not also a plain tag.
    if (post.githubRelease) {
      githubRelease = {
        slug: project.slug,
        dir: project.dir,
        displayName: post.githubRelease.displayName,
        assets: post.assets ?? [],
      }
      tags.push({ slug: project.slug, dir: project.dir, viaRelease: true })
    } else if (post.tag) {
      tags.push({ slug: project.slug, dir: project.dir, viaRelease: false })
    }
  }

  return { tags, githubRelease }
}

/** The nx `release` block this catalog implies. */
export function renderNxRelease (catalog = loadCatalog()) {
  const groups = {}
  for (const train of Object.values(catalog.trains)) {
    for (const [groupName, group] of Object.entries(train.groups)) {
      if (groups[groupName]) {
        throw new Error(
          `Release group '${groupName}' is declared by more than one train; group names are global to nx.`
        )
      }
      groups[groupName] = {
        projects: group.projects.map((p) => p.name),
        projectsRelationship: group.projectsRelationship,
        versionPlans: true,
      }
    }
  }

  // No releaseTag: nx tags a fixed group once and leaves {projectName}
  // uninterpolated there, while this repo tags each package after its own
  // publish. release-train.yml does the tagging.
  return {
    groups,
    versionPlans: true,
    version: { ...catalog.nx.version },
  }
}

/** nx.json with the generated release block in place. */
export function renderNxJson (catalog = loadCatalog()) {
  const nxJson = JSON.parse(readRepoFile(NX_JSON))
  nxJson.release = renderNxRelease(catalog)
  return JSON.stringify(nxJson, null, 2) + '\n'
}
