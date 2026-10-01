#!/usr/bin/env node
/**
 * Print, as JSON, the train packages whose version moved between two commits:
 * [{ "name", "slug", "version", "changelog" }]. pr-release-guard.yml checks
 * each one's changelog section, and that npm does not have the version yet,
 * before a release train PR merges.
 *
 * Usage: node .github/scripts/release-train-moved.mjs <ref> <base-sha> <head-sha>
 */
import { execFileSync } from 'node:child_process'
import { movedProjects } from './lib/release-train-guard.mjs'

function readManifestAt (sha, path) {
  try {
    return execFileSync('git', ['show', `${sha}:${path}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function main () {
  const [ref, baseSha, headSha] = process.argv.slice(2)
  if (!ref || !baseSha || !headSha) {
    console.error('usage: release-train-moved.mjs <ref> <base-sha> <head-sha>')
    process.exit(2)
  }
  console.log(JSON.stringify(movedProjects(ref, baseSha, headSha, readManifestAt)))
}

main()
