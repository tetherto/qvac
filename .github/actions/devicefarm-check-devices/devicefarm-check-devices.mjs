#!/usr/bin/env node
// Fails a manual mobile run before any build when its devices or tests filter cannot work.

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const MAX_DEVICES = 10
export const MAX_RUNS = 40
export const TESTS_FILTER = /^[A-Za-z0-9_ |().*+-]+$/

export const parseModels = (s) =>
  [
    ...new Set(
      String(s)
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    )
  ].sort()

// Runner names come from test-groups.json when the package shards, else its generated runner file.
export function runnerSource(groupsPath, autoPath, platform) {
  const key = platform === 'Android' ? 'android' : 'ios'
  const path = groupsPath || autoPath
  if (!path) return { runners: [], specs: 1 }
  if (!existsSync(path))
    throw new Error(`${path} not found; cannot check the tests filter or run count`)
  const text = readFileSync(path, 'utf8')
  const groups = groupsPath ? JSON.parse(text)[key] || {} : null
  const runners = groups
    ? [...new Set(Object.values(groups).flat())]
    : [...new Set([...text.matchAll(/async function (run[A-Za-z0-9_]+)/g)].map((m) => m[1]))]
  if (!runners.length) throw new Error(`no ${key} runner names in ${path}`)
  return { runners, specs: groups ? Object.keys(groups).length : 1 }
}

export function check({ models, operator, tests, source, fleet }) {
  if (!['EQUALS', 'CONTAINS'].includes(operator))
    throw new Error(`device-model-operator must be EQUALS or CONTAINS, got '${operator}'`)
  if (!models.length) throw new Error('no device selected; name at least one, e.g. Google Pixel 9')
  if (models.length > MAX_DEVICES)
    throw new Error(`${models.length} devices requested, the cap is ${MAX_DEVICES}`)
  let specs = source.specs
  if (tests) {
    if (!TESTS_FILTER.test(tests))
      throw new Error(
        `tests filter '${tests}' may hold only letters, digits and _ space | ( ) . * + -`
      )
    // An invalid regex is a zero-match, as grep -E treated it.
    let re
    try {
      re = new RegExp(tests)
    } catch {
      re = { test: () => false }
    }
    if (source.runners.length && !source.runners.some((r) => re.test(r)))
      throw new Error(`tests filter '${tests}' matches none of: ${source.runners.join(', ')}`)
    specs = 1
  }
  if (specs * models.length > MAX_RUNS)
    throw new Error(
      `${specs} specs x ${models.length} devices exceeds ${MAX_RUNS} runs; filter tests or pick fewer devices`
    )
  const hits = (m) => [
    ...new Set(fleet.filter((d) => (operator === 'EQUALS' ? d === m : d.includes(m))))
  ]
  const missing = models.filter((m) => !hits(m).length)
  if (missing.length)
    throw new Error(
      `no ${operator} match on Device Farm for: ${missing.join(', ')}. Models: ${[...new Set(fleet)].sort().join(', ')}`
    )
  const claimed = models.flatMap(hits)
  const twice = [...new Set(claimed.filter((m, i) => claimed.indexOf(m) !== i))]
  if (twice.length)
    throw new Error(
      `selectors overlap on ${twice.join(', ')}, which would be billed twice; use EQUALS with exact names`
    )
  return specs * models.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  if (env.PACKAGE && env.PREBUILD_RUN_ID)
    throw new Error('Set package or prebuild_run_id, not both')
  const filter = JSON.stringify([
    {
      attribute: 'PLATFORM',
      operator: 'EQUALS',
      values: [env.PLATFORM === 'Android' ? 'ANDROID' : 'IOS']
    }
  ])
  const fleet = JSON.parse(
    execFileSync('aws', ['devicefarm', 'list-devices', '--filters', filter, '--output', 'json'], {
      encoding: 'utf8'
    })
  ).devices.map((d) => d.model)
  if (!fleet.length)
    throw new Error('Device Farm listed no devices; the role needs devicefarm:ListDevices')
  const runs = check({
    models: parseModels(env.DEVICES),
    operator: env.OPERATOR || 'CONTAINS',
    tests: env.TESTS,
    source: runnerSource(env.GROUPS_PATH, env.AUTO_PATH, env.PLATFORM),
    fleet
  })
  console.log(`Devices OK: ${runs} Device Farm run(s)`)
}
