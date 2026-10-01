/**
 * The train builds against the pnpm workspace, which is what removes the wait
 * for npm between its own packages. The same linking also reaches siblings the
 * train does not publish: pnpm links a workspace copy whenever its version
 * satisfies the range, so a package can be built against a sibling at a
 * version only this checkout has.
 *
 * The per-package workflows cannot hit this, because they install from the
 * registry and fail when a range does not resolve. Here the train publishes
 * cleanly and a consumer installing from npm resolves the range to an older
 * version than the one the build used.
 *
 * So every workspace-linked dependency outside the train has to be on npm at
 * the version the build linked. Whether pnpm linked a sibling or fetched it is
 * pnpm's decision, read back from its own resolution rather than re-derived
 * from the range here.
 */
import { trainProjects } from './release-trains.mjs'

/**
 * Workspace packages a train's projects link but the train does not publish,
 * with the version this checkout linked.
 *
 * @param {string} train
 * @param {(project: {name: string, dir: string}) => Array<{name: string, version: string, range: string}>} resolvedDeps
 *   each project's direct dependencies as pnpm resolved them; `version` is
 *   `link:<path>` for a workspace link
 * @param {(name: string) => string} workspaceVersion   version of a linked package
 * @param {object} [catalog]
 */
export function linkedOutsideTrain (train, resolvedDeps, workspaceVersion, catalog) {
  const projects = trainProjects(train, catalog)
  const inTrain = new Set(projects.map((project) => project.name))
  const linked = new Map()

  for (const project of projects) {
    for (const dep of resolvedDeps(project)) {
      if (inTrain.has(dep.name)) continue
      if (!dep.version.startsWith('link:')) continue
      if (!linked.has(dep.name)) {
        linked.set(dep.name, {
          name: dep.name,
          version: workspaceVersion(dep.name),
          range: dep.range,
          dependents: [],
        })
      }
      linked.get(dep.name).dependents.push(project.name)
    }
  }

  return [...linked.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Those of them npm does not have at the linked version. Each one would ship a
 * train built against code no consumer can install.
 *
 * @param {Array<{name: string, version: string}>} linked
 * @param {(name: string, version: string) => boolean} isPublished
 */
export function unpublishedLinks (linked, isPublished) {
  return linked.filter((dep) => !isPublished(dep.name, dep.version))
}
