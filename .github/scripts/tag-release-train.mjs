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
 * Idempotent: an existing tag is left alone, so re-running a train that
 * half-shipped does not fail and does not move a tag someone is depending on.
 *
 * Usage: node .github/scripts/tag-release-train.mjs <train> [--push]
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { postPublishPlan, readRepoFile, repoRoot, tagFor } from './lib/release-trains.mjs'

function git (args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim()
}

function tagExists (tag) {
  try {
    git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`])
    return true
  } catch {
    return false
  }
}

function main () {
  const [name, ...flags] = process.argv.slice(2)
  const push = flags.includes('--push')

  if (!name) {
    console.error('usage: tag-release-train.mjs <train> [--push]')
    process.exit(2)
  }

  const { tags } = postPublishPlan(name)
  const created = []

  for (const target of tags) {
    if (target.viaRelease) {
      console.log(`${target.slug}: tagged by its GitHub release, skipping`)
      continue
    }

    const manifest = join(target.dir, 'package.json')
    const { version } = JSON.parse(readRepoFile(manifest))
    const tag = tagFor(target, version)

    if (tagExists(tag)) {
      console.log(`${tag}: already exists, leaving it alone`)
      continue
    }

    git(['tag', '--annotate', tag, '--message', tag])
    created.push(tag)
    console.log(`${tag}: created`)
  }

  if (!created.length) {
    console.log('no new tags')
    return
  }

  if (push) {
    git(['push', 'origin', ...created])
    console.log(`pushed ${created.length} tag(s)`)
  } else {
    console.log(`--push not set; ${created.length} tag(s) left local`)
  }
}

main()
