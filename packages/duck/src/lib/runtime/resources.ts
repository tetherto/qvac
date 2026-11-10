interface ResourceFS {
  readFileSync(path: string): Uint8Array
  readdirSync(path: string): string[]
}
interface ResourcePath {
  join(...paths: string[]): string
  resolve(...paths: string[]): string
  dirname(path: string): string
}
interface ResourceOptions {
  cwd?: string
  home?: string | undefined
  fs?: ResourceFS | undefined
  path?: ResourcePath | undefined
}
export interface ContextFile {
  path: string
  content: string
}
import b4a from 'b4a'
import { parseTemplate } from '../../product/templates.js'

const CAP = 64 * 1024
// Bare modules throw under Node, so tests inject node:fs/node:path instead.
const bare: { fs?: ResourceFS; path?: ResourcePath; home?: string } = globalThis.Bare
  ? await Promise.all([import('bare-fs'), import('bare-path'), import('bare-os')]).then(
      ([fs, path, os]) => ({
        fs: fs.default,
        path: path.default,
        home: os.default.homedir()
      })
    )
  : {}

function read(fs: ResourceFS, file: string, cap = Infinity) {
  try {
    const data = fs.readFileSync(file)
    return b4a.toString(data.length > cap ? data.subarray(0, cap) : data, 'utf8')
  } catch {
    return null
  }
}

function list(fs: ResourceFS, dir: string) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name: string) => name.endsWith('.md'))
      .sort()
  } catch {
    return []
  }
}

export function loadTemplates({
  cwd,
  home = bare.home,
  fs = bare.fs,
  path = bare.path
}: ResourceOptions = {}) {
  if (!fs || !path) throw new Error('Resource filesystem and path adapters are required')
  const byName = new Map<string, ReturnType<typeof parseTemplate> & { source: string }>()
  for (const [source, root] of [
    ['user', home],
    ['project', cwd]
  ] as const) {
    if (!root) continue
    const dir = path.join(root, '.qvac', 'prompts')
    for (const file of list(fs, dir)) {
      const text = read(fs, path.join(dir, file))
      if (text === null) {
        continue
      }

      const name = file.slice(0, -3)
      byName.set(name, { ...parseTemplate(name, text), source })
    }
  }

  return [...byName.values()]
}

export function loadContextFiles({
  cwd,
  home = bare.home,
  fs = bare.fs,
  path = bare.path
}: ResourceOptions = {}) {
  if (!fs || !path || !cwd) throw new Error('Context filesystem, path and cwd are required')
  const dirs: string[] = []
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.unshift(dir)
    if (path.dirname(dir) === dir) {
      break
    }
  }

  const candidates = [
    home ? [path.join(home, '.qvac', 'AGENTS.md')] : [],
    ...dirs.map((d) => [path.join(d, 'AGENTS.md'), path.join(d, 'CLAUDE.md')])
  ]
  const out = []
  for (const options of candidates) {
    for (const file of options) {
      const content = read(fs, file, CAP)
      if (content === null) {
        continue
      }

      out.push({ path: file, content })
      break
    }
  }

  return out
}

export function contextPreamble(files: ContextFile[]) {
  if (!files.length) return ''
  const blocks = files.map(
    (f: { path: string; content: string }) =>
      `<context file="${f.path.replace(/"/g, '&quot;')}">\n${f.content.trimEnd()}\n</context>`
  )

  return `The following context files contain project instructions; follow them while working in this project.\n\n${blocks.join('\n\n')}\n\n`
}
