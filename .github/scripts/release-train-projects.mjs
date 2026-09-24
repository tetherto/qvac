#!/usr/bin/env node
/**
 * Print what a train contains, so workflows never hardcode the list.
 *
 * Usage:
 *   node .github/scripts/release-train-projects.mjs <train> [--projects|--dist-paths|--sidecars]
 */
import { getTrain, postPublishPlan, trainProjects } from './lib/release-trains.mjs'

const MODES = '--projects|--dist-paths|--sidecars|--github-release'

function main () {
  const [name, mode = '--projects'] = process.argv.slice(2)

  if (!name) {
    console.error(`usage: release-train-projects.mjs <train> [${MODES}]`)
    process.exit(2)
  }

  const projects = trainProjects(name)

  switch (mode) {
    case '--projects':
      console.log(projects.map((p) => p.name).join(','))
      break
    case '--dist-paths':
      // One per line; upload-artifact takes a multi-line `path`.
      console.log(projects.map((p) => `${p.dir}/dist/`).join('\n'))
      break
    case '--sidecars':
      console.log(JSON.stringify(getTrain(name).sidecars ?? []))
      break
    case '--github-release':
      // Empty object when the train declares none, so a workflow can test a
      // field rather than parse a failure.
      console.log(JSON.stringify(postPublishPlan(name).githubRelease ?? {}))
      break
    default:
      console.error(`unknown mode '${mode}'`)
      process.exit(2)
  }
}

main()
