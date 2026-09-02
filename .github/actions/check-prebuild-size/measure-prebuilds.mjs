import fs from 'node:fs'
import path from 'node:path'

export const BYTES_PER_MB = 1000 * 1000
export const DEFAULT_TOP_COUNT = 10

function isSizedEntry (entry) {
  return entry.isFile() || entry.isSymbolicLink()
}

function entrySize (absolutePath) {
  const stat = fs.lstatSync(absolutePath)
  return stat.isSymbolicLink() ? 0 : stat.size
}

function readDirEntries (dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
}

export function collectFiles (root) {
  const files = []
  const pending = [root]

  while (pending.length > 0) {
    const dir = pending.pop()
    for (const entry of readDirEntries(dir)) {
      const absolutePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolutePath)
        continue
      }
      if (!isSizedEntry(entry)) {
        continue
      }
      files.push({
        relativePath: path.relative(root, absolutePath),
        bytes: entrySize(absolutePath)
      })
    }
  }

  return files
}

export function totalBytes (files) {
  return files.reduce((sum, file) => sum + file.bytes, 0)
}

export function largestFiles (files, count = DEFAULT_TOP_COUNT) {
  return [...files].sort((a, b) => b.bytes - a.bytes).slice(0, count)
}

function targetOf (relativePath) {
  const [first] = relativePath.split(path.sep)
  return first ?? relativePath
}

export function bytesByTarget (files) {
  const totals = new Map()
  for (const file of files) {
    const target = targetOf(file.relativePath)
    totals.set(target, (totals.get(target) ?? 0) + file.bytes)
  }
  return [...totals.entries()]
    .map(([target, bytes]) => ({ target, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
}

export function toMb (bytes) {
  return bytes / BYTES_PER_MB
}

export function formatMb (bytes) {
  return `${toMb(bytes).toFixed(1)} MB`
}

export function exceedsLimit (bytes, limitMb) {
  if (limitMb === null) {
    return false
  }
  return toMb(bytes) > limitMb
}

export function measure (root, { topCount = DEFAULT_TOP_COUNT } = {}) {
  const files = collectFiles(root)
  return {
    fileCount: files.length,
    bytes: totalBytes(files),
    byTarget: bytesByTarget(files),
    largest: largestFiles(files, topCount)
  }
}

function renderTargetRows (byTarget) {
  return byTarget.map(({ target, bytes }) => `| \`${target}\` | ${formatMb(bytes)} |`)
}

function renderLargestRows (largest) {
  return largest.map(({ relativePath, bytes }) => `| \`${relativePath}\` | ${formatMb(bytes)} |`)
}

export function renderReport (measurement, limitMb) {
  const limitLine = limitMb === null
    ? 'No limit configured (reporting only).'
    : `Limit: ${limitMb.toFixed(1)} MB.`

  return [
    '## Prebuild size',
    '',
    `Total: **${formatMb(measurement.bytes)}** across ${measurement.fileCount} files. ${limitLine}`,
    '',
    '| Target | Size |',
    '| --- | --- |',
    ...renderTargetRows(measurement.byTarget),
    '',
    `<details><summary>${measurement.largest.length} largest files</summary>`,
    '',
    '| File | Size |',
    '| --- | --- |',
    ...renderLargestRows(measurement.largest),
    '',
    '</details>',
    ''
  ].join('\n')
}

export function parseLimitMb (raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null
  }
  const limit = Number(raw)
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`max-total-mb must be a positive number, got "${raw}"`)
  }
  return limit
}
