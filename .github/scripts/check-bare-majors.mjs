#!/usr/bin/env node
/**
 * Fail when a package touched by a diff still pins `bare` or a `bare-*`
 * dependency (including devDependencies) to an older major than npm latest.
 *
 * Reads package.json blobs from `--tree`. It does not import those packages.
 *
 * Usage:
 *   node .github/scripts/check-bare-majors.mjs --base <sha> --tree <sha>
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import {
  bareDeps,
  findLags,
  formatLag,
  packageJsonsForChangedFiles,
} from './lib/bare-majors.mjs'

function parseArgs(argv) {
  const args = { base: '', tree: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--base' || arg === '--tree') {
      const value = argv[i + 1]
      if (!value) throw new Error(`${arg} needs a git revision`)
      args[arg.slice(2)] = value
      i++
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!args.base || !args.tree) throw new Error('--base and --tree are required')
  return args
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function treeHas(tree, path) {
  const result = spawnSync('git', ['cat-file', '-e', `${tree}:${path}`], { encoding: 'utf8' })
  return result.status === 0
}

function readManifest(tree, path) {
  const text = git(['show', `${tree}:${path}`])
  return JSON.parse(text)
}

function changedFiles(base, tree) {
  const out = git(['diff', '--name-only', `${base}...${tree}`])
  return out.split('\n').map((line) => line.trim()).filter(Boolean)
}

export function latestVersion(name) {
  const result = spawnSync('npm', ['view', name, 'version'], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`npm view ${name} failed:\n${result.stderr || result.stdout}`)
  }
  const version = result.stdout.trim().split('\n').filter(Boolean).pop()
  if (!version) throw new Error(`npm view ${name} returned no version`)
  return version
}

export function lagsForTree({ base, tree, latest = latestVersion }) {
  const files = changedFiles(base, tree)
  const manifests = packageJsonsForChangedFiles(files, (path) => treeHas(tree, path))
  const lags = []
  for (const file of manifests) {
    const rows = bareDeps(readManifest(tree, file))
    const latestByName = {}
    for (const row of rows) {
      if (!(row.name in latestByName)) latestByName[row.name] = latest(row.name)
    }
    for (const lag of findLags(rows, latestByName)) lags.push({ file, ...lag })
  }
  return lags
}

function main() {
  const { base, tree } = parseArgs(process.argv.slice(2))
  const lags = lagsForTree({ base, tree })
  if (lags.length === 0) {
    console.log('Touched packages accept the current bare majors.')
    return
  }
  for (const lag of lags) {
    const message = formatLag(lag.file, lag)
    console.error(message)
    console.error(`::error file=${lag.file}::${message}`)
  }
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
