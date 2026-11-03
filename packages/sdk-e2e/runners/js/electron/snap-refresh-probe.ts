import { close, heartbeat, modelRegistryList } from '@qvac/sdk'
import * as fs from 'node:fs'
import * as path from 'node:path'

interface SnapRefreshMarker {
  home: string
  registryFiles: string[]
  revision: string
  snapCommon: string
}

function listRelativeFiles(root: string, current: string = root): string[] {
  if (!fs.existsSync(current)) return []

  const files: string[] = []
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name)
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(root, entryPath))
    } else if (entry.isFile()) {
      files.push(path.relative(root, entryPath))
    }
  }
  return files.sort()
}

function readMarker(markerPath: string): SnapRefreshMarker {
  return JSON.parse(fs.readFileSync(markerPath, 'utf8')) as SnapRefreshMarker
}

export async function runSnapRefreshProbe(prepareConfig: () => void) {
  prepareConfig()

  const home = process.env['HOME']
  const revision = process.env['SNAP_REVISION']
  const snapCommon = process.env['SNAP_USER_COMMON']
  const phase = process.env['QVAC_TEST_SNAP_PROBE_PHASE']
  if (!home || !revision || !snapCommon || !phase) {
    throw new Error(
      'Snap refresh probe requires HOME, SNAP_REVISION, SNAP_USER_COMMON, and QVAC_TEST_SNAP_PROBE_PHASE'
    )
  }

  const runtimeDir = path.join(snapCommon, 'qvac-test-runtime')
  const markerPath = path.join(runtimeDir, 'snap-refresh-marker.json')
  const registryRoot = path.join(snapCommon, '.qvac', 'registry-corestore')
  const workerLock = path.join(snapCommon, '.qvac', '.worker.lock')

  if (phase === 'before') {
    await heartbeat()
    if (!fs.existsSync(workerLock)) {
      throw new Error(`SDK worker lock was not created in Snap common storage: ${workerLock}`)
    }
    if (fs.existsSync(path.join(home, '.qvac'))) {
      throw new Error(`SDK unexpectedly created revision-scoped storage under ${home}`)
    }

    await modelRegistryList()
    await close()
    const registryFiles = listRelativeFiles(registryRoot)
    if (registryFiles.length === 0) {
      throw new Error(
        `SDK registry did not create persistent Corestore files under ${registryRoot}`
      )
    }

    const marker: SnapRefreshMarker = { home, registryFiles, revision, snapCommon }
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`)
  } else if (phase === 'after') {
    const marker = readMarker(markerPath)
    if (marker.snapCommon !== snapCommon) {
      throw new Error(
        `SNAP_USER_COMMON changed across refresh: ${marker.snapCommon} -> ${snapCommon}`
      )
    }
    if (marker.home === home || marker.revision === revision) {
      throw new Error(
        `Snap revision did not change: HOME ${marker.home} -> ${home}, revision ${marker.revision} -> ${revision}`
      )
    }

    const registryFiles = listRelativeFiles(registryRoot)
    const missingRegistryFiles = marker.registryFiles.filter(
      (fileName) => !registryFiles.includes(fileName)
    )
    if (missingRegistryFiles.length > 0) {
      throw new Error(
        `SDK registry files disappeared across refresh: ${missingRegistryFiles.join(', ')}`
      )
    }

    await modelRegistryList()
    if (!fs.existsSync(workerLock)) {
      throw new Error(`SDK worker did not reopen with common storage after refresh: ${workerLock}`)
    }
    if (fs.existsSync(path.join(home, '.qvac'))) {
      throw new Error(`SDK unexpectedly created revision-scoped storage under ${home}`)
    }
    await close()
  } else {
    throw new Error(`Unknown Snap refresh probe phase: ${phase}`)
  }

  console.log(
    JSON.stringify({
      phase,
      home,
      revision,
      snapCommon,
      workerLock,
      registryFiles: listRelativeFiles(registryRoot)
    })
  )
}
