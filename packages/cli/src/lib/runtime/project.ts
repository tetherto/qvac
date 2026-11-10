interface ProjectFS {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
  readdirSync(path: string): string[]
}
import path from '#path'

export const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'deno.json'
]

// home and / hold dotfiles and stray manifests, so neither ever counts as a project
export function projectRoot(
  cwd: string,
  fs: Pick<ProjectFS, 'existsSync'>,
  { home = null }: { home?: string | null } = {}
) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (dir === home || dir === path.dirname(dir)) {
      return null
    }

    if (PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))) {
      return dir
    }
  }
}

// With no marker the folder you start in is the project, unless it is /, home or holds home
export function workFolder(
  cwd: string,
  fs: Pick<ProjectFS, 'existsSync'>,
  { home = null }: { home?: string | null } = {}
) {
  const dir = path.resolve(cwd)
  const holdsHome = home !== null && (dir === home || home.startsWith(dir + path.sep))

  return projectRoot(dir, fs, { home }) ?? (holdsHome || dir === path.dirname(dir) ? null : dir)
}

// How the project runs its tests, read from its manifests; null when nothing says.
export function testCommand(root: string, fs: ProjectFS) {
  const has = (name: string) => fs.existsSync(path.join(root, name))
  const read = (name: string) => (has(name) ? fs.readFileSync(path.join(root, name), 'utf8') : '')
  const script = scripts(read('package.json'))['test']
  if (script && !script.includes('no test specified')) {
    return 'npm test'
  }

  if (has('Cargo.toml')) {
    return 'cargo test'
  }

  if (has('go.mod')) {
    return 'go test ./...'
  }

  if (
    ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini'].some((f) => read(f).includes('pytest'))
  ) {
    return 'python3 -m pytest'
  }

  const python = files(root, fs).find((f: string) => /^test_.*\.py$|_test\.py$/.test(f))
  if (python) {
    return `python3 -m unittest discover -p "${python.startsWith('test_') ? 'test_*.py' : '*_test.py'}"`
  }

  if (has('CMakeLists.txt')) {
    return 'cmake -S . -B build && cmake --build build && ctest --test-dir build'
  }

  if (/^test:/m.test(read('Makefile'))) {
    return 'make test'
  }

  return null
}

function scripts(json: string): Record<string, string> {
  try {
    return JSON.parse(json).scripts ?? {}
  } catch {
    return {}
  }
}

function files(root: string, fs: ProjectFS) {
  try {
    return fs.readdirSync(root)
  } catch {
    return []
  }
}
