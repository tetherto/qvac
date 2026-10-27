// npm does not consume Bun's patchedDependencies, so replay the pinned harness patches without git.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function patchDependencies(directory = root, { check = false } = {}) {
  // pnpm owns patches in its content-addressed store; never modify its links.
  if (process.env.npm_config_user_agent?.startsWith('pnpm/')) {
    return { check, changes: 0, results: [{ state: 'managed by pnpm patchedDependencies' }] }
  }
  const harness = packageRoot('@qvac/harness', directory)
  const patches =
    JSON.parse(fs.readFileSync(path.join(harness, 'package.json'), 'utf8')).patchedDependencies ||
    {}
  const changes = []
  const results = []
  for (const [identity, relative] of Object.entries(patches)) {
    const planned = planPackage(identity, {
      directory: harness,
      patch: path.join(harness, relative)
    })
    changes.push(...planned)
    results.push({
      package: identity,
      state: planned.length ? 'patched' : 'already patched',
      files: planned.length
    })
  }

  // Nothing is written until the whole set validates; each hunk recognises its patched text on retry.
  if (!check) {
    writeChanges(changes)
  }

  return { check, changes: changes.length, results }
}

function packageRoot(name, directory) {
  const resolve = createRequire(path.join(directory, 'package.json')).resolve
  let resolved
  try {
    resolved = resolve(name + '/package.json')
  } catch {
    resolved = resolve(name)
  }
  for (let current = path.dirname(resolved); ; current = path.dirname(current)) {
    const manifest = path.join(current, 'package.json')
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) {
      return current
    }
    if (path.dirname(current) === current) throw new Error(`Cannot locate package ${name}`)
  }
}

function planPackage(identity, { directory, patch }) {
  const at = identity.lastIndexOf('@')
  const name = identity.slice(0, at)
  const version = identity.slice(at + 1)
  const target = packageRoot(name, directory)
  const installed = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'))
  if (installed.version !== version) {
    throw new Error(
      `Cannot patch ${identity}: installed ${installed.version}; update the pinned harness patch first`
    )
  }

  if (fs.realpathSync(target).includes(`${path.sep}.pnpm${path.sep}`)) {
    throw new Error(`Use pnpm install to apply the workspace patch for ${identity}`)
  }
  const changes = []
  for (const file of parsePatch(fs.readFileSync(patch, 'utf8'), name)) {
    const change = planFile(file, { target, name, identity })
    if (change) {
      changes.push(change)
    }
  }

  return changes
}

function planFile(file, { target, name, identity }) {
  const destination = path.resolve(target, file.name)
  if (!destination.startsWith(path.resolve(target) + path.sep)) {
    throw new Error(`Patch path escapes ${name}: ${file.name}`)
  }

  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
    throw new Error(`Refusing to patch symlink ${destination}`)
  }

  const exists = fs.existsSync(destination)
  if (!exists && !file.created) {
    throw new Error(`Patch target missing: ${destination}`)
  }

  const before = exists ? fs.readFileSync(destination, 'utf8') : ''
  const after = applyFile(before, file, identity)

  return !exists || before !== after ? { destination, after } : null
}

function writeChanges(changes) {
  for (const { destination, after } of changes) {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const temporary = destination + `.qvac-patch-${process.pid}`
    fs.writeFileSync(temporary, after)
    fs.renameSync(temporary, destination)
  }
}

function parsePatch(source, packageName) {
  return source
    .split(/^diff --git /m)
    .slice(1)
    .map((section) => parseFile(section.split('\n'), packageName))
}

function parseFile(lines, packageName) {
  const name = patchedName(lines, packageName)
  const file = {
    name,
    created: lines.some((line) => line.startsWith('new file mode')),
    hunks: []
  }
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].startsWith('@@ ')) continue
    const { hunk, end } = parseHunk(lines, { at: i, name })
    file.hunks.push(hunk)
    i = end
  }

  return file
}

function patchedName(lines, packageName) {
  const heading = lines[0].match(/^a\/(.+) b\/(.+)$/)
  if (!heading) {
    throw new Error(`Unsupported patch header for ${packageName}`)
  }

  const named = lines.find((line) => line.startsWith('+++ '))?.slice(4) || 'b/' + heading[2]
  if (named === '/dev/null') {
    throw new Error('Deleted patch files are not supported')
  }

  let name = named.replace(/^[ab]\//, '')
  const prefix = `node_modules/${packageName}/`
  if (name.startsWith(prefix)) {
    name = name.slice(prefix.length)
  }

  if (name.split(/[\\/]/).includes('..') || path.isAbsolute(name)) {
    throw new Error(`Invalid patch path ${name}`)
  }

  return name
}

function parseHunk(lines, { at, name }) {
  const header = lines[at].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
  if (!header) {
    throw new Error(`Invalid hunk in ${name}`)
  }

  const hunk = { start: Number(header[1]), old: [], next: [] }
  const oldCount = header[2] === undefined ? 1 : Number(header[2])
  const newCount = header[4] === undefined ? 1 : Number(header[4])
  let i = at
  while (i + 1 < lines.length && !lines[i + 1].startsWith('@@ ')) {
    addHunkLine(hunk, { line: lines[++i], name })
    if (hunk.old.length === oldCount && hunk.next.length === newCount) {
      break
    }
  }

  if (hunk.old.length !== oldCount || hunk.next.length !== newCount) {
    throw new Error(`Hunk line counts do not match in ${name}`)
  }

  return { hunk, end: i }
}

function addHunkLine(hunk, { line, name }) {
  const prefix = line[0]
  if (prefix === ' ' || prefix === '-') {
    hunk.old.push(line.slice(1))
  }

  if (prefix === ' ' || prefix === '+') {
    hunk.next.push(line.slice(1))
  }

  if (prefix === '\\') {
    throw new Error(`No-newline patch requires explicit support: ${name}`)
  }
}

function applyFile(source, file, identity) {
  if (!file.hunks.length) return source
  const lines = source ? source.split('\n') : []
  if (lines.at(-1) === '') {
    lines.pop()
  }

  let delta = 0
  const matches = (index, wanted) =>
    index >= 0 && wanted.every((line, offset) => lines[index + offset] === line)
  for (const hunk of file.hunks) {
    const index = Math.max(0, hunk.start - 1) + delta
    if (hunk.next.length && matches(index, hunk.next)) {
      delta += hunk.next.length - hunk.old.length
      continue
    }

    if (!matches(index, hunk.old)) {
      throw new Error(
        `Patch mismatch in ${identity}/${file.name} at line ${hunk.start}; refusing a fuzzy patch`
      )
    }

    lines.splice(index, hunk.old.length, ...hunk.next)
    delta += hunk.next.length - hunk.old.length
  }

  return lines.join('\n') + '\n'
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(patchDependencies(root, { check: process.argv.includes('--check') }), null, 2)
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
