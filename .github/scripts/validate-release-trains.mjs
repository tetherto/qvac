#!/usr/bin/env node
/**
 * Fail if nx.json's release block has drifted from .github/release-trains.json,
 * or if the catalog describes something the workspace does not have.
 *
 * Usage: node .github/scripts/validate-release-trains.mjs
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  CATALOG,
  NX_JSON,
  loadCatalog,
  readRepoFile,
  renderNxJson,
  repoRoot,
  trainNames,
  trainProjects,
} from './lib/release-trains.mjs'

function main () {
  const catalog = loadCatalog()
  const errors = []

  if (readRepoFile(NX_JSON) !== renderNxJson(catalog)) {
    errors.push(
      `${NX_JSON} does not match ${CATALOG}. Run: node .github/scripts/sync-release-trains.mjs`
    )
  }

  const seen = new Map()
  for (const name of trainNames(catalog)) {
    const train = catalog.trains[name]
    let releaseCount = 0

    if (!train.groups[train.anchorGroup]) {
      errors.push(`train '${name}': anchorGroup '${train.anchorGroup}' is not one of its groups`)
    } else if (train.groups[train.anchorGroup].projectsRelationship !== 'fixed') {
      errors.push(
        `train '${name}': anchorGroup '${train.anchorGroup}' must be "fixed" — the branch carries one version for it`
      )
    }

    for (const project of trainProjects(name, catalog)) {
      const manifest = join(project.dir, 'package.json')
      if (!existsSync(join(repoRoot, manifest))) {
        errors.push(`train '${name}': ${project.name} declares ${manifest}, which does not exist`)
        continue
      }
      const actual = JSON.parse(readRepoFile(manifest)).name
      if (actual !== project.name) {
        errors.push(`train '${name}': ${manifest} is '${actual}', catalog says '${project.name}'`)
      }
      const previous = seen.get(project.name)
      if (previous) {
        errors.push(`${project.name} is in both '${previous}' and '${name}'; a package rides one train`)
      }
      seen.set(project.name, name)

      const post = project.postPublish
      if (!post) {
        errors.push(
          `train '${name}': ${project.name} declares no postPublish, so a release would leave it untagged`
        )
        continue
      }
      if (post.githubRelease) {
        releaseCount += 1
        if (post.tag) {
          errors.push(
            `train '${name}': ${project.name} asks for both a tag and a githubRelease; the release carries its own tag`
          )
        }
        if (!post.githubRelease.displayName) {
          errors.push(`train '${name}': ${project.name} githubRelease needs a displayName`)
        }
      } else if (!post.tag) {
        errors.push(`train '${name}': ${project.name} postPublish must set tag or githubRelease`)
      }

      for (const asset of post.assets ?? []) {
        const declared = catalog.assets?.[asset]
        if (!declared) {
          errors.push(`train '${name}': ${project.name} wants asset '${asset}', which the catalog does not declare`)
          continue
        }
        if (declared.requires === 'githubRelease' && !post.githubRelease) {
          errors.push(
            `train '${name}': asset '${asset}' attaches to a GitHub release, which ${project.name} does not create`
          )
        }
        if (!existsSync(join(repoRoot, declared.workflow))) {
          errors.push(`asset '${asset}' names ${declared.workflow}, which does not exist`)
        }
      }
    }

    // release-train.yml holds one github-release job, so one per train.
    if (releaseCount > 1) {
      errors.push(`train '${name}': ${releaseCount} projects declare a githubRelease; at most one is supported`)
    }

    for (const sidecar of train.sidecars ?? []) {
      if (!existsSync(join(repoRoot, sidecar.dir))) {
        errors.push(`train '${name}': sidecar ${sidecar.name} declares ${sidecar.dir}, which does not exist`)
      }
      if (sidecar.versionFrom && !seen.has(sidecar.versionFrom)) {
        errors.push(
          `train '${name}': sidecar ${sidecar.name} takes its version from ${sidecar.versionFrom}, which is not in the train`
        )
      }
    }
  }

  for (const err of errors) {
    console.error(`::error::${err}`)
  }

  if (errors.length) {
    console.error(`validate-release-trains: ${errors.length} error(s)`)
    process.exit(1)
  }

  console.log(`validate-release-trains: ${trainNames(catalog).length} train(s) OK`)
}

main()
