#!/usr/bin/env node
// Publishes a package to GitHub Packages as @tetherto/<name><suffix>, versioned per run unless it is a release.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// A release ref always publishes latest; otherwise the given tag, else the one the branch implies.
export function distTag({ tag, event, refName }) {
  if (['push', 'workflow_dispatch'].includes(event) && refName.startsWith('release-'))
    return 'latest'
  return (
    tag ||
    (refName.startsWith('feature-') ? 'feature' : refName.startsWith('tmp-') ? 'temp' : 'dev')
  )
}

export function publishVersion({ version, tag, pr, runId }) {
  if (tag === 'latest') return version
  return pr ? `${version}-tmp.pr-${pr}.runid-${runId}` : `${version}-tmp.runid-${runId}`
}

export function gprName(name, suffix) {
  const [scope, base] = name.replace(/^@qvac\//, '@tetherto/').split('/')
  return `${scope}/${base}${suffix}`
}

const bare = (name) => `${name.replace(/^@/, '').replace('/', '__')}.bare`

// cmake-bare names a module after the package, so the built name stays reachable under the new one.
export function linkBareAliases(dir, from, to) {
  const [old, now] = [bare(from), bare(to)]
  const prebuilds = join(dir, 'prebuilds')
  if (old === now || !existsSync(prebuilds)) return 0
  let n = 0
  for (const p of readdirSync(prebuilds)) {
    for (const [a, b] of [
      [old, now],
      [`${old}.exports`, `${now}.exports`]
    ]) {
      if (!existsSync(join(prebuilds, p, a))) continue
      rmSync(join(prebuilds, p, b), { force: true })
      symlinkSync(a, join(prebuilds, p, b))
      n++
    }
  }
  return n
}

// rename-prefix, as main's release pipeline ran it before the alias links: every qvac_* name under prebuilds, deepest first,
// and binding.js's references become tetherto_.
export function renamePrefix(dir) {
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => [
      ...(e.isDirectory() ? walk(join(d, e.name)) : []),
      { dir: d, name: e.name }
    ])
  const prebuilds = join(dir, 'prebuilds')
  const renamed = existsSync(prebuilds)
    ? walk(prebuilds).filter((e) => e.name.startsWith('qvac_'))
    : []
  for (const e of renamed)
    renameSync(join(e.dir, e.name), join(e.dir, e.name.replace(/^qvac_/, 'tetherto_')))
  const binding = join(dir, 'binding.js')
  if (existsSync(binding))
    writeFileSync(binding, readFileSync(binding, 'utf8').replaceAll('qvac_', 'tetherto_'))
  return renamed.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const dir = env.WORKDIR.replace(/\/$/, '') || '.'
  if (dir.startsWith('/') || dir.includes('..') || !existsSync(dir))
    throw new Error(`invalid workdir: ${dir}`)
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  const manifestPath = join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const tag = distTag({
    tag: env.TAG,
    event: env.GITHUB_EVENT_NAME,
    refName: env.GITHUB_REF_NAME
  })
  const version = publishVersion({
    version: pkg.version,
    tag,
    pr: event.pull_request?.number,
    runId: env.GITHUB_RUN_ID
  })
  const name = gprName(pkg.name, env.NAME_SUFFIX)
  if (env.NAME_TRANSFORM === 'rename-prefix')
    console.log(`Renamed ${renamePrefix(dir)} qvac_ files`)
  else if (env.NAME_TRANSFORM) throw new Error(`unknown name transform '${env.NAME_TRANSFORM}'`)
  linkBareAliases(dir, pkg.name, name)
  writeFileSync(manifestPath, `${JSON.stringify({ ...pkg, name, version }, null, 2)}\n`)
  // npm expands ${NODE_AUTH_TOKEN} itself, so the token is never written to disk.
  const npmrc = join(env.RUNNER_TEMP, 'publish-gpr.npmrc')
  writeFileSync(
    npmrc,
    '@tetherto:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n'
  )
  const npm = (args, opts) =>
    execFileSync('npm', [...args, '--userconfig', npmrc], {
      cwd: dir,
      ...opts
    })
  try {
    npm(['view', `${name}@${version}`, 'version'], { stdio: 'ignore' })
    console.log(`::error::${name}@${version} already exists in GitHub Packages`)
  } catch {}
  npm(['publish', '--tag', tag], { stdio: 'inherit' })
  console.log(`::notice title=GPR published::${name}@${version} (${tag})`)
  appendFileSync(env.GITHUB_OUTPUT, `name=${name}\nversion=${version}\n`)
  appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    `## Installation\n\n\`\`\`bash\nnpm install ${name}@${version}\n\`\`\`\n`
  )
}
