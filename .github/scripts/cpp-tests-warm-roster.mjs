import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PACKAGES_DIR = 'packages'
const PROJECT_FILE = 'project.json'
const PR_TARGET = 'on-pr'
const CPP_TESTS_TARGET = 'test:cpp'

export const WARMED_ELSEWHERE = new Map([
  ['diffusion-cpp', 'on-merge-vcpkg-cache-diffusion.yml'],
  ['embed-llamacpp', 'on-merge-vcpkg-cache-embed.yml'],
])

export const SHARED_CACHE_INPUTS = [
  '.github/workflows/cpp-tests-nx.yml',
  '.github/actions/vcpkg-',
  '.github/scripts/configure-cpp-build.mjs',
  'vcpkg-overlays/',
]

function declaresMatrixCi(target) {
  const ci = target?.options?.ci
  return Boolean(ci) && ci.carveOut !== true
}

export function buildsInNxCppTests(project) {
  const targets = project.targets ?? {}
  return declaresMatrixCi(targets[PR_TARGET]) && declaresMatrixCi(targets[CPP_TESTS_TARGET])
}

export function selectRoster(projects) {
  return [...projects]
    .filter(([name, project]) => buildsInNxCppTests(project) && !WARMED_ELSEWHERE.has(name))
    .map(([name]) => name)
    .sort()
}

function touchesSharedCacheInput(paths) {
  return paths.some((path) => SHARED_CACHE_INPUTS.some((input) => path.startsWith(input)))
}

function touchesPackage(paths, name) {
  return paths.some((path) => path.startsWith(`${PACKAGES_DIR}/${name}/`))
}

export function selectPushedPackages(roster, changedPaths) {
  if (changedPaths === null || touchesSharedCacheInput(changedPaths)) return roster
  return roster.filter((name) => touchesPackage(changedPaths, name))
}

export function readProjects(root) {
  return new Map(readdirSync(join(root, PACKAGES_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, PACKAGES_DIR, entry.name, PROJECT_FILE)))
    .map((entry) => [entry.name, JSON.parse(readFileSync(join(root, PACKAGES_DIR, entry.name, PROJECT_FILE), 'utf8'))]))
}

function readChangedPaths(file) {
  if (!file) return null
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
}

function main() {
  const roster = selectRoster(readProjects(process.cwd()))
  console.log(`roster=${JSON.stringify(roster)}`)
  console.log(`packages=${JSON.stringify(selectPushedPackages(roster, readChangedPaths(process.argv[2])))}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
