#!/usr/bin/env node
/**
 * Tag each package a train published, as <slug>-v<version>.
 *
 * Replaces the per-package `create-release-tag.yml` call for the train path:
 * one run publishes every package, so one job tags every package. Which
 * projects get a tag comes from `postPublish` in .github/release-trains.json.
 *
 * A project whose release is a GitHub release is skipped — create-github-release
 * makes that tag itself.
 *
 * Idempotent against origin: a tag already there at this commit is left alone,
 * so re-running a train that half-shipped does not fail and does not move a tag
 * someone is depending on. A tag there at another commit fails the run. See
 * .github/scripts/lib/release-train-tags.mjs.
 *
 * Usage: node .github/scripts/tag-release-train.mjs <train> <ref> <base-sha> [--push]
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { movedProjects } from './lib/release-train-guard.mjs'
import { planTags, parseLsRemote } from './lib/release-train-tags.mjs'
import { postPublishPlan, readRepoFile, repoRoot } from './lib/release-trains.mjs'

function git (args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim()
}

function showAt (sha, path) {
  try {
    return execFileSync('git', ['show', `${sha}:${path}`], { cwd: repoRoot, encoding: 'utf-8' })
  } catch {
    return null
  }
}

function main () {
  const [name, ref, baseSha, ...flags] = process.argv.slice(2)
  const push = flags.includes('--push')

  if (!name || !ref || !baseSha) {
    console.error('usage: tag-release-train.mjs <train> <ref> <base-sha> [--push]')
    process.exit(2)
  }

  const head = git(['rev-parse', 'HEAD'])
  const movedSlugs = new Set(movedProjects(ref, baseSha, head, showAt).map((project) => project.slug))
  const plan = planTags(postPublishPlan(name).tags, {
    movedSlugs,
    versionOf: (dir) => JSON.parse(readRepoFile(join(dir, 'package.json'))).version,
    remoteCommit: (tag) =>
      parseLsRemote(git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]), tag),
    head,
  })

  for (const slug of plan.unchanged) console.log(`${slug}: not moved by this train, skipping`)
  for (const slug of plan.viaRelease) console.log(`${slug}: tagged by its GitHub release, skipping`)
  for (const tag of plan.existing) console.log(`${tag}: already on origin at ${head}, leaving it alone`)

  if (plan.conflicts.length) {
    for (const { tag, commit } of plan.conflicts) {
      console.error(`::error::${tag} already exists on origin at ${commit}, expected ${head}`)
    }
    process.exit(1)
  }

  if (!plan.create.length) {
    console.log('no new tags')
    return
  }

  for (const tag of plan.create) {
    git(['tag', '--annotate', '--force', tag, '--message', tag])
    console.log(`${tag}: created at ${head}`)
  }

  if (push) {
    git(['push', 'origin', ...plan.create.map((tag) => `refs/tags/${tag}`)])
    console.log(`pushed ${plan.create.length} tag(s)`)
  } else {
    console.log(`--push not set; ${plan.create.length} tag(s) left local`)
  }
}

main()
