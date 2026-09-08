// The version rules that tie @qvac/sdk's manifest to @qvac/inference. Both are
// checked here and every failure is reported in one run.
//
// 1. Addon ranges. @qvac/inference's peerDependencies is the source of truth for
//    the inference addons. For every addon p in it, inference's
//    devDependencies.p and the SDK's dependencies.p must carry the identical
//    range.
//
// 2. Shared major.minor. @qvac/sdk and @qvac/inference expose the same API, so
//    the major and minor of the SDK's own version must equal the major and minor
//    of the @qvac/inference range it depends on. Patch numbers are free on both
//    sides, so @qvac/sdk 0.19.4 may depend on @qvac/inference ^0.19.2. The range
//    operator must hold the dependency inside that one major.minor: a caret does
//    below 1.0.0 (^0.19.0 is >=0.19.0 <0.20.0) but not from 1.0.0 up (^1.19.0
//    also allows 1.20.0), so a tilde is required there.
//
// The second rule reads @qvac/sdk's manifest alone and never
// packages/inference's version. The two move independently between releases —
// the engine is published first and the SDK follows — so comparing them would
// fail main for as long as that takes.

import { readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

type Ranges = Record<string, string>

interface Manifest {
  version?: string
  dependencies?: Ranges
  devDependencies?: Ranges
  peerDependencies?: Ranges
}

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inferenceDir = resolve(sdkDir, '..', 'inference')
const dependency = '@qvac/inference'

function readManifest(dir: string) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
}

const inferencePkg = readManifest(inferenceDir)
const sdkPkg = readManifest(sdkDir)

function checkAddonRanges() {
  const peers = inferencePkg.peerDependencies ?? {}
  const inferenceDev = inferencePkg.devDependencies ?? {}
  const sdkDeps = sdkPkg.dependencies ?? {}

  const drifts: string[] = []
  for (const [name, peer] of Object.entries(peers)) {
    const dev = inferenceDev[name]
    const dep = sdkDeps[name]
    const mismatches: string[] = []
    if (dep !== peer) mismatches.push(dep === undefined ? 'SDK is missing it' : `SDK has ${dep}`)
    if (dev !== peer) {
      mismatches.push(
        dev === undefined
          ? 'inference devDependencies is missing it'
          : `inference devDependencies has ${dev}`
      )
    }
    if (mismatches.length > 0) {
      drifts.push(
        `${name}: inference has it as ${peer} in peerDependencies, but ${mismatches.join(' and ')}.`
      )
    }
  }

  if (drifts.length === 0) return []
  return [
    `${drifts.join('\n')}\n\nPlease ensure the SDK dependencies and inference devDependencies use the same addon versions as inference's peerDependencies.`
  ]
}

function checkSharedMajorMinor() {
  const rawVersion = sdkPkg.version
  const rawRange = sdkPkg.dependencies?.[dependency]

  if (rawVersion === undefined) return [`${join(sdkDir, 'package.json')} declares no version.`]
  if (rawRange === undefined) {
    return [`${join(sdkDir, 'package.json')} declares no ${dependency} dependency.`]
  }

  // Specs that point somewhere other than the published package: the workspace
  // link used for development and the pod checks (`sdk-source:workspace` writes
  // `file:../inference`), and the npm alias the GPR dev build pins. They carry no
  // major.minor to compare, so there is nothing to check.
  const localPrefixes = ['file:', 'link:', 'npm:']
  const localSpec = localPrefixes.find(function (prefix) {
    return rawRange.startsWith(prefix)
  })
  if (localSpec !== undefined) {
    console.log(
      `${dependency} points at "${rawRange}", not a published version; skipping the major.minor check.`
    )
    return []
  }

  const versionMatch = /^(\d+)\.(\d+)\.\d+$/.exec(rawVersion)
  if (versionMatch === null) {
    return [`@qvac/sdk version "${rawVersion}" is not a plain x.y.z version.`]
  }
  const sdkMajorMinor = `${versionMatch[1]}.${versionMatch[2]}`

  const rangeMatch = /^([\^~])(\d+)\.(\d+)\.\d+$/.exec(rawRange)
  if (rangeMatch === null) {
    return [
      `${dependency} is declared as "${rawRange}", which this check cannot read.\n` +
        `Write it as one caret or tilde range over an exact version, e.g. "^${sdkMajorMinor}.0".`
    ]
  }
  const operator = rangeMatch[1]
  const rangeMajorMinor = `${rangeMatch[2]}.${rangeMatch[3]}`

  if (sdkMajorMinor !== rangeMajorMinor) {
    return [
      `Version mismatch: @qvac/sdk is ${rawVersion} (major.minor ${sdkMajorMinor}) but depends ` +
        `on ${dependency} "${rawRange}" (major.minor ${rangeMajorMinor}).\n\n` +
        `The two ship the same API and must share a major.minor. Either set the range to ` +
        `${sdkMajorMinor}, or move @qvac/sdk to ${rangeMajorMinor}.0 — publishing ` +
        `@qvac/inference ${rangeMajorMinor}.0 first, so the range resolves from npm.`
    ]
  }

  if (Number(rangeMatch[2]) >= 1 && operator !== '~') {
    return [
      `${dependency} is declared as "${rawRange}". From 1.0.0 up, a caret range also allows the ` +
        `next minor, which is a different API. Use "~${rawRange.slice(1)}".`
    ]
  }

  return []
}

const failures = [...checkAddonRanges(), ...checkSharedMajorMinor()]

if (failures.length > 0) {
  console.error(failures.join('\n\n'))
  process.exit(1)
}
