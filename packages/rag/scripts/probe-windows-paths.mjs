// Measures what the host file system actually allows, so the TurboVec path
// limits can be reasoned about from data instead of from the documented
// Windows numbers. Runs under both runtimes, since Bare and Node reach the
// file system through different bindings:
//
//   bare scripts/probe-windows-paths.mjs C:\some\dir
//   node scripts/probe-windows-paths.mjs C:\some\dir
//
// The directory is created if missing and removed at the end. Pass a directory
// whose own path is short, so the probe has room to grow paths inside it.

const isBare = typeof Bare !== 'undefined'
const argv = isBare ? Bare.argv : process.argv
const fs = isBare ? (await import('bare-fs')).default : (await import('node:fs')).default
const path = isBare ? (await import('bare-path')).default : (await import('node:path')).default

const runtime = isBare ? `bare ${Bare.version ?? 'unknown'}` : `node ${process.version}`
const platform = isBare ? Bare.platform : process.platform

const requested = argv[argv.length - 1]
if (!requested || requested.endsWith('.mjs')) {
  console.log('usage: <bare|node> scripts/probe-windows-paths.mjs <directory>')
  throw new Error('a probe directory is required')
}

const baseDir = path.resolve(requested)
const summary = {
  runtime,
  platform,
  baseDir,
  baseDirLength: baseDir.length,
  checks: {}
}

// The failing paths are hundreds of characters long and the message repeats
// them, so keep only the head of it.
function shorten(message) {
  const text = String(message).replace(/\s+/g, ' ')
  return text.length > 90 ? `${text.slice(0, 90)}...` : text
}

function attempt(action) {
  try {
    action()
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      code: error && error.code ? String(error.code) : null,
      errno: error && typeof error.errno === 'number' ? error.errno : null,
      message: error && error.message ? shorten(error.message) : shorten(error)
    }
  }
}

function describe(result) {
  if (result.ok) return 'ok'
  return `${result.code ?? 'no code'} errno ${result.errno ?? 'none'}`
}

function record(name, result, extra = {}) {
  summary.checks[name] = { ...extra, ...result }
  const detail = Object.entries(extra)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  console.log(`${name.padEnd(34)} ${describe(result).padEnd(28)} ${detail}`)
  if (!result.ok) console.log(`${''.padEnd(34)} ${result.message}`)
}

// Builds a name that makes `parent + separator + name` exactly `total` long.
function nameForTotal(parent, total, prefix) {
  const room = total - parent.length - 1
  if (room < prefix.length) return null
  return prefix + 'x'.repeat(room - prefix.length)
}

function section(title) {
  console.log('')
  console.log(`--- ${title}`)
}

// 1. Environment.

section('environment')
console.log(`runtime            ${runtime}`)
console.log(`platform           ${platform}`)
console.log(`probe directory    ${baseDir}`)
console.log(`its length         ${baseDir.length}`)

record(
  'base directory created',
  attempt(() => fs.mkdirSync(baseDir, { recursive: true }))
)

// 2. How long a directory path this system accepts. Directories are created
// one level at a time so the exact failing length is known, rather than
// letting a recursive mkdir hide which level failed.

section('directory path limit')

let deepest = path.join(baseDir, 'depth')
record(
  'depth root created',
  attempt(() => fs.mkdirSync(deepest)),
  { length: deepest.length }
)

for (let step = 0; step < 40; step++) {
  const candidate = path.join(deepest, 'd'.repeat(40))
  const result = attempt(() => fs.mkdirSync(candidate))
  if (!result.ok) {
    record('coarse directory failure', result, { length: candidate.length })
    break
  }
  deepest = candidate
}

let maxDirectoryPath = deepest.length
let directoryLimitFound = false
for (let extra = 1; extra <= 250; extra++) {
  const candidate = path.join(deepest, 'e'.repeat(extra))
  const result = attempt(() => fs.mkdirSync(candidate))
  if (!result.ok) {
    record('exact directory failure', result, { length: candidate.length })
    directoryLimitFound = true
    break
  }
  maxDirectoryPath = candidate.length
}
summary.maxDirectoryPath = maxDirectoryPath
summary.directoryLimitFound = directoryLimitFound
console.log(
  directoryLimitFound
    ? `longest directory path accepted: ${maxDirectoryPath}`
    : `no directory limit found up to ${maxDirectoryPath}`
)

// 3. How long a file path this system accepts, measured inside a directory
// that is known to work.

section('file path limit')

const fileParent = path.join(baseDir, 'files')
record(
  'file parent created',
  attempt(() => fs.mkdirSync(fileParent)),
  { length: fileParent.length }
)

let maxFilePath = 0
let fileLimitFound = false
for (let total = fileParent.length + 2; total <= fileParent.length + 253; total++) {
  const name = nameForTotal(fileParent, total, 'f')
  if (name === null) continue
  const candidate = path.join(fileParent, name)
  const result = attempt(() => fs.writeFileSync(candidate, 'probe'))
  if (!result.ok) {
    record('exact file failure', result, { length: candidate.length })
    fileLimitFound = true
    break
  }
  maxFilePath = candidate.length
}
summary.maxFilePath = maxFilePath
summary.fileLimitFound = fileLimitFound
console.log(
  fileLimitFound
    ? `longest file path accepted: ${maxFilePath}`
    : `no file limit found up to ${maxFilePath}`
)

// 4. Whether the extended-length prefix lifts the limit. If it does, the real
// cure is to apply it inside the file layer rather than to shorten names.

section('extended-length prefix')

if (platform === 'win32') {
  const longName = 'g'.repeat(200)
  const plain = path.join(fileParent, longName)
  record(
    'plain long file path',
    attempt(() => fs.writeFileSync(plain, 'probe')),
    { length: plain.length }
  )

  const prefixed = `\\\\?\\${plain}`
  record(
    'prefixed long file path',
    attempt(() => fs.writeFileSync(prefixed, 'probe')),
    { length: prefixed.length }
  )

  const prefixedDir = `\\\\?\\${path.join(fileParent, 'h'.repeat(200))}`
  record(
    'prefixed long directory',
    attempt(() => fs.mkdirSync(prefixedDir)),
    { length: prefixedDir.length }
  )
} else {
  console.log('skipped: not win32')
}

// 5. Flushing a handle. The adapter writes a file, reopens it and flushes it.
// Windows only flushes a handle that carries write access, and never accepts a
// directory handle at all.

section('flush behaviour')

const flushDir = path.join(baseDir, 'flush')
fs.mkdirSync(flushDir)
const flushFile = path.join(flushDir, 'target.json')
fs.writeFileSync(flushFile, 'probe')

record(
  'open file r then flush',
  attempt(() => {
    const fd = fs.openSync(flushFile, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  })
)

record(
  'open file r+ then flush',
  attempt(() => {
    const fd = fs.openSync(flushFile, 'r+')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  })
)

record(
  'open directory r',
  attempt(() => {
    const fd = fs.openSync(flushDir, 'r')
    fs.closeSync(fd)
  })
)

record(
  'open directory r then flush',
  attempt(() => {
    const fd = fs.openSync(flushDir, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  })
)

// 6. The adapter's own layout, with the long owner label and with the short
// one, step by step. This is the head-to-head the fix rests on.

function probeLayout(label, labelLength) {
  section(`adapter layout with a ${labelLength} character owner label`)

  const identity = 'a'.repeat(64)
  const owner = 'b'.repeat(labelLength)
  const root = path.join(baseDir, label)
  const workspace = path.join(root, `database-${identity}`)
  const lock = path.join(workspace, 'writer.lock')
  const temporary = path.join(lock, `owner.json.tmp-${owner}`)
  const owned = path.join(lock, 'owner.json')
  const stale = `${lock}.stale-${owner}-0`

  const steps = {}
  steps.workspace = attempt(() => fs.mkdirSync(workspace, { recursive: true }))
  record(`${label} workspace directory`, steps.workspace, { length: workspace.length })

  steps.lock = attempt(() => fs.mkdirSync(lock))
  record(`${label} lock directory`, steps.lock, { length: lock.length })

  steps.temporary = attempt(() => fs.writeFileSync(temporary, '{}\n'))
  record(`${label} temporary owner file`, steps.temporary, { length: temporary.length })

  steps.flush = attempt(() => {
    const fd = fs.openSync(temporary, 'r+')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  })
  record(`${label} flush temporary file`, steps.flush)

  steps.install = attempt(() => fs.renameSync(temporary, owned))
  record(`${label} install owner file`, steps.install, { length: owned.length })

  steps.stale = attempt(() => fs.renameSync(lock, stale))
  record(`${label} stale rename`, steps.stale, { length: stale.length })

  summary.checks[`${label} longest path`] = {
    ok: true,
    value: Math.max(temporary.length, stale.length)
  }
  return {
    longest: Math.max(temporary.length, stale.length),
    relative: Math.max(temporary.length, stale.length) - root.length
  }
}

const long = probeLayout('layout-64', 64)
const short = probeLayout('layout-12', 12)

// 7. What room is left for a real installation. The relative figure is the
// part the adapter builds; the rest is whatever directory the application
// keeps its data in.

section('room left for an application data directory')
console.log(`64 character label: adapter builds ${long.relative} characters`)
console.log(`12 character label: adapter builds ${short.relative} characters`)
if (fileLimitFound) {
  console.log(`64 character label: data directory may be ${maxFilePath - long.relative} long`)
  console.log(`12 character label: data directory may be ${maxFilePath - short.relative} long`)
} else {
  console.log('this system imposed no limit, so there is nothing to divide up')
}
summary.applicationRoom = {
  longLabelRelative: long.relative,
  shortLabelRelative: short.relative,
  longLabelAllowance: fileLimitFound ? maxFilePath - long.relative : null,
  shortLabelAllowance: fileLimitFound ? maxFilePath - short.relative : null
}

// 8. Clean up. Removing a tree that contains an over-long path can itself
// fail, so say so rather than leaving it silently behind.

section('cleanup')
const cleanup =
  typeof fs.rmSync === 'function'
    ? attempt(() => fs.rmSync(baseDir, { recursive: true, force: true }))
    : { ok: false, code: 'UNSUPPORTED', errno: null, message: 'this runtime has no rmSync' }
record('probe directory removed', cleanup)
if (!cleanup.ok) console.log(`remove by hand: ${baseDir}`)

section('summary to paste back')
console.log(JSON.stringify(summary, null, 2))
