import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_BUILD_JOBS = 2
const PACKAGE_NAME = /^[a-z][a-z0-9-]*$/

export function configureCppBuild(environment) {
  const jobs = environment.CPP_BUILD_JOBS || String(DEFAULT_BUILD_JOBS)
  if (!/^[1-9][0-9]*$/.test(jobs)) throw new Error('CPP_BUILD_JOBS must be a positive integer')
  if (!PACKAGE_NAME.test(environment.CPP_PACKAGE || '')) throw new Error('CPP_PACKAGE must be a package short-name')
  const settings = {
    CMAKE_BUILD_PARALLEL_LEVEL: jobs,
    VCPKG_MAX_CONCURRENCY: jobs,
  }
  if (environment.CPP_HAS_CCACHE === 'true') {
    if (!environment.RUNNER_TEMP || !environment.GITHUB_WORKSPACE) throw new Error('Ccache needs RUNNER_TEMP and GITHUB_WORKSPACE')
    Object.assign(settings, {
      CCACHE_DIR: join(environment.RUNNER_TEMP, 'cpp-ccache', environment.CPP_PACKAGE),
      CCACHE_BASEDIR: environment.GITHUB_WORKSPACE,
      CCACHE_COMPILERCHECK: 'content',
      CMAKE_C_COMPILER_LAUNCHER: 'ccache',
      CMAKE_CXX_COMPILER_LAUNCHER: 'ccache',
    })
  }
  return settings
}

export function writeBuildSettings(environment) {
  const settings = configureCppBuild(environment)
  const lines = Object.entries(settings).map(([key, value]) => {
    if (/[\r\n]/.test(value)) throw new Error(`${key} must be a single line`)
    return `${key}=${value}\n`
  })
  appendFileSync(environment.GITHUB_ENV, lines.join(''))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeBuildSettings(process.env)
}
