#!/usr/bin/env node
// The QIP's publish:post, run once a release is published and tagged. Its own command runs here, without its task
// dependencies; each target it depends on is dispatched to the workflow that owns it, for this package at the release
// tag, on the platforms publish:post's configurations name (all of the target's when it names none).

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The group workflow that runs each target, as the QIP's workflow table assigns them, and the dispatch inputs that
// select one package on some of the target's configurations.
export const OWNERS = {
  benchmark: {
    workflow: 'benchmarks.yml',
    inputs: (pkg, configs) => [{ packages: pkg, ...(configs.length ? { configs: configs.join(',') } : {}) }]
  },
  'test:integration': { workflow: 'pr-build-test.yml', inputs: (pkg) => [{ packages: pkg }], allConfigs: true },
  'test:backend': { workflow: 'pr-build-test.yml', inputs: (pkg) => [{ packages: pkg }], allConfigs: true },
  'test:mobile': {
    workflow: 'mobile-tests.yml',
    inputs: (pkg, configs) =>
      [
        ['android-arm64', 'Android', 'Google Pixel 9'],
        ['ios-arm64', 'iOS', 'Apple iPhone 16 Pro']
      ]
        .filter(([config]) => !configs.length || configs.includes(config))
        .map(([, platform, device]) => ({ packages: pkg, platform, device }))
  }
}

// What publish:post asks for: the dispatches to send, or an error naming what is wrong.
export function plan(project, pkg) {
  const post = project.targets['publish:post']
  const configs = Object.keys(post.configurations ?? {})
  const deps = (post.dependsOn ?? []).map((d) => (typeof d === 'string' ? d : d.target))
  const dispatches = []
  for (const dep of deps) {
    const owner = OWNERS[dep]
    if (!owner) throw new Error(`publish:post depends on ${dep}, which no workflow runs after publishing`)
    const known = Object.keys(project.targets[dep]?.configurations ?? {})
    const missing = configs.filter((c) => !known.includes(c))
    if (missing.length) throw new Error(`publish:post names ${missing.join(', ')}, which ${dep} does not define`)
    if (configs.length && owner.allConfigs)
      throw new Error(`${owner.workflow} runs every ${dep} configuration; drop publish:post's configurations`)
    for (const inputs of owner.inputs(pkg, configs)) dispatches.push({ target: dep, workflow: owner.workflow, inputs })
  }
  return dispatches
}

async function dispatch(env, { workflow, inputs }, ref) {
  const res = await fetch(
    `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ ref, inputs })
    }
  )
  if (!res.ok) throw new Error(`dispatch ${workflow}: ${res.status} ${await res.text()}`)
}

async function main(env) {
  const nx = (args, opts = {}) =>
    execFileSync('pnpm', ['exec', 'nx', ...args], { encoding: 'utf8', ...opts })
  const project = JSON.parse(nx(['show', 'project', env.PROJECT, '--json']))
  const pkg = basename(env.DIR)
  const prefix = project.targets.publish?.metadata?.publish?.tagPrefix
  const { version } = JSON.parse(readFileSync(join(env.DIR, 'package.json'), 'utf8'))
  const tag = env.DISPATCH_REF || `${prefix}-v${version}`
  const dispatches = plan(project, pkg)
  nx(['run', `${env.PROJECT}:publish:post`, '--exclude-task-dependencies', '--outputStyle=stream'], {
    stdio: 'inherit'
  })
  const runs = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/workflows`
  const lines = [`### publish:post ${pkg} at ${tag}`, '']
  for (const d of dispatches) {
    await dispatch(env, d, tag)
    const args = Object.entries(d.inputs)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.log(`Dispatched ${d.workflow} for ${d.target}: ${args}`)
    lines.push(`- ${d.target}: [${d.workflow}](${runs}/${d.workflow}?query=branch%3A${tag}) with ${args}`)
  }
  if (!dispatches.length) lines.push('- nothing dispatched; publish:post ran here')
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.env)
