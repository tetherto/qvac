#!/usr/bin/env node
// A producer row's Device Farm run: `schedule -- <command>` picks a pool (a named one, else an available private one,
// else a random public one) and schedules one run, then runs the package's producer phase with RUN_ARNS; `stop` stops
// the run and waits for it to finish, so its artifacts exist. The job holds the AWS credentials.

import { appendFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const DONE = ['COMPLETED', 'STOPPED', 'ERRORED']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const summary = (lines) =>
  process.env.GITHUB_STEP_SUMMARY &&
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
const output = (pairs) =>
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(pairs)
      .map(([k, v]) => `${k}=${v}\n`)
      .join('')
  )
const shuffle = (list) => {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export const awsCli = (args) =>
  JSON.parse(
    execFileSync('aws', ['devicefarm', ...args, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  )

const errorText = (e) => String(e.stderr || e.message).replace(/\s+/g, ' ')

// A pool's positive ARN and INSTANCE_ARN rules; attribute pools and NOT_IN rules give none, a failed read too.
export function poolTargets(arn, aws) {
  let rules
  try {
    rules = aws(['get-device-pool', '--arn', arn]).devicePool?.rules ?? []
  } catch (e) {
    console.log(`    get-device-pool failed: ${errorText(e)}`)
    return { deviceArns: [], instanceArns: [] }
  }
  const values = (rule) => {
    let decoded = rule.value
    try {
      decoded = JSON.parse(rule.value)
    } catch {}
    return Array.isArray(decoded) ? decoded : [decoded]
  }
  const pick = (attribute, marker) => [
    ...new Set(
      rules
        .filter((r) => ['EQUALS', 'IN'].includes(r.operator) && r.attribute === attribute)
        .flatMap(values)
        .filter((v) => typeof v === 'string' && v.includes(marker))
    )
  ]
  return {
    deviceArns: pick('ARN', ':device:'),
    instanceArns: pick('INSTANCE_ARN', ':deviceinstance:')
  }
}

// The best public availability across the pool's devices: a likelihood over the fleet, never a reason to fail.
export function publicAvailability(arns, aws, quiet = false) {
  let devices
  try {
    devices = aws([
      'list-devices',
      '--filters',
      JSON.stringify([{ attribute: 'ARN', operator: 'IN', values: arns }])
    ]).devices
  } catch (e) {
    if (!quiet) console.log(`    list-devices failed: ${errorText(e)}`)
    return 'UNKNOWN'
  }
  if (!quiet)
    for (const d of devices)
      console.log(`      - ${d.name ?? '?'} (os ${d.os ?? '?'}): ${d.availability ?? 'null'}`)
  const seen = devices.map((d) => d.availability)
  return (
    ['HIGHLY_AVAILABLE', 'AVAILABLE', 'BUSY', 'TEMPORARY_NOT_AVAILABLE'].find((a) =>
      seen.includes(a)
    ) ?? 'UNKNOWN'
  )
}

// A private pool's readiness is its device instances' status: AVAILABLE now, IN_USE or PREPARING busy.
export function privateAvailability(targets, aws) {
  const byInstance = targets.instanceArns.length > 0
  const arns = byInstance ? targets.instanceArns : targets.deviceArns
  if (!arns.length) return 'UNKNOWN'
  let devices
  try {
    devices = aws([
      'list-devices',
      '--filters',
      JSON.stringify([
        { attribute: byInstance ? 'INSTANCE_ARN' : 'ARN', operator: 'IN', values: arns }
      ])
    ]).devices
  } catch (e) {
    console.log(`    list-devices failed: ${errorText(e)}`)
    return 'UNKNOWN'
  }
  const statuses = []
  for (const d of devices)
    for (const i of d.instances ?? []) {
      if (byInstance && !arns.includes(i.arn)) continue
      console.log(`      - ${d.name ?? '?'} (os ${d.os ?? '?'}, instance ${i.arn}): ${i.status}`)
      if (i.status) statuses.push(i.status)
    }
  if (statuses.includes('AVAILABLE')) return 'AVAILABLE'
  if (statuses.includes('IN_USE') || statuses.includes('PREPARING')) return 'BUSY'
  if (statuses.includes('NOT_AVAILABLE')) return 'TEMPORARY_NOT_AVAILABLE'
  return 'UNKNOWN'
}

export function selectPool(pools, name, aws, order = shuffle) {
  if (!Array.isArray(pools) || !pools.length)
    throw new Error(`device pools is not a non-empty JSON array: ${JSON.stringify(pools)}`)
  if (name) {
    const hit = pools.find((p) => p.name === name)
    if (!hit)
      throw new Error(
        `device pool '${name}' not found; pools: ${pools.map((p) => p.name).join(', ')}`
      )
    return { ...hit, reason: 'named: selected by name', availability: 'UNKNOWN' }
  }
  // A private pool counts only when ready now; anything else falls through, so private capacity never blocks a run.
  const privates = pools.filter((p) => p.p === true)
  if (privates.length) {
    console.log(`Probing ${privates.length} private device pool(s) (availability required)...`)
    for (const p of order(privates)) {
      const targets = poolTargets(p.arn, aws)
      if (!targets.deviceArns.length && !targets.instanceArns.length) {
        console.log(`  - '${p.name}': UNKNOWN (no device or instance ARN in its rules)`)
        continue
      }
      console.log(`  - '${p.name}':`)
      const availability = privateAvailability(targets, aws)
      if (availability === 'AVAILABLE')
        return { ...p, reason: `private: ${availability}`, availability }
      console.log(`    private pool not ready: ${availability}`)
    }
    console.log('No private device pool is available; continuing with the public pools.')
    summary([
      '### Private device pool fallback',
      '',
      'No private pool had an instance `AVAILABLE`; a public pool was chosen.',
      ''
    ])
  } else console.log('No private device pool configured; choosing a public pool.')
  const random = pools.filter((p) => p.p !== true && p.r !== false)
  if (!random.length)
    throw new Error(
      'no random-eligible public device pool; add a non-private entry without "r": false, or name a pool'
    )
  console.log(`Probing ${random.length} public device pool(s) (availability is a preference)...`)
  const seen = []
  for (const p of order(random)) {
    const { deviceArns } = poolTargets(p.arn, aws)
    if (!deviceArns.length) {
      console.log(`  - '${p.name}': no device ARN in its rules; no availability hint`)
      seen.push({ ...p, availability: 'UNKNOWN' })
      continue
    }
    console.log(`  - '${p.name}':`)
    seen.push({ ...p, availability: publicAvailability(deviceArns, aws) })
  }
  const manual = pools.filter((p) => p.p !== true && p.r === false)
  if (manual.length) console.log(`Selectable by name only (${manual.length}, "r": false):`)
  for (const p of manual) {
    const { deviceArns } = poolTargets(p.arn, aws)
    const a = deviceArns.length ? publicAvailability(deviceArns, aws, true) : 'UNKNOWN'
    console.log(`  - '${p.name}': ${a} (skipped)`)
  }
  for (const want of ['HIGHLY_AVAILABLE', 'AVAILABLE']) {
    const hit = seen.find((p) => p.availability === want)
    if (hit) return { ...hit, reason: `random: ${want}` }
  }
  const pick = seen[0]
  console.log(
    `::warning::Device Farm busy: no pool reported AVAILABLE (best pick '${pick.name}' is ${pick.availability}). Proceeding; the run fails if no device starts within the start timeout.`
  )
  return { ...pick, reason: `random: best-effort (${pick.availability})` }
}

export async function stopAndWait(arns, aws, { polls = 120, intervalMs = 15000 } = {}) {
  for (const arn of arns) {
    const status = () => {
      try {
        return aws(['get-run', '--arn', arn]).run.status
      } catch {
        return 'UNKNOWN'
      }
    }
    let now = status()
    console.log(`${arn}: ${now}`)
    if (['RUNNING', 'PENDING'].includes(now)) {
      try {
        aws(['stop-run', '--arn', arn])
      } catch (e) {
        console.log(`stop-run failed: ${errorText(e)}`)
      }
    }
    // Up to 30 minutes, so the run's artifacts exist before the logs are downloaded.
    for (let i = 1; i <= polls && !DONE.includes(now); i++) {
      await sleep(intervalMs)
      now = status()
      if (i % 6 === 0) console.log(`${arn}: still ${now} (${i}/${polls})`)
    }
    console.log(`${arn}: finished as ${now}`)
  }
}

async function main(command, env, producer) {
  if (command === 'stop') return stopAndWait(JSON.parse(env.RUN_ARNS || '[]'), awsCli)
  if (command !== 'schedule') throw new Error('usage: devicefarm-pool-run.mjs schedule|stop')
  const pool = selectPool(JSON.parse(env.POOLS || '[]'), (env.DEVICES || '').trim(), awsCli)
  console.log(`Selected device pool '${pool.name}' (${pool.reason}): ${pool.arn}`)
  summary([
    `### Selected device pool: \`${pool.name}\``,
    '',
    `- reason: ${pool.reason}`,
    `- availability: ${pool.availability}`
  ])
  const spec = JSON.parse(env.SPECS)[0]?.arn
  if (!spec || !/^\d+$/.test(env.TIMEOUT))
    throw new Error('SPECS needs an arn and TIMEOUT a number')
  const name = `${basename(env.WORKDIR)}-${env.CONFIG}-${pool.name}-${env.GITHUB_RUN_NUMBER}-${env.GITHUB_RUN_ATTEMPT}`
  const arn = awsCli([
    'schedule-run',
    '--project-arn',
    env.PROJECT_ARN,
    '--device-pool-arn',
    pool.arn,
    '--app-arn',
    env.APP_ARN,
    '--name',
    name,
    '--test',
    JSON.stringify({ type: 'APPIUM_NODE', testPackageArn: env.PACKAGE_ARN, testSpecArn: spec }),
    '--execution-configuration',
    JSON.stringify({ jobTimeoutMinutes: Number(env.TIMEOUT) })
  ]).run.arn
  const project = env.PROJECT_ARN.split(':project:')[1]
  const run = arn.split(':run:')[1]?.split('/')[1]
  const url = `https://us-west-2.console.aws.amazon.com/devicefarm/home#/mobile/projects/${project}/runs/${run}`
  console.log(`Scheduled ${name}: ${arn}\nDevice Farm console: ${url}`)
  summary([`### Device Farm: ${pool.name}`, `[Open Device Farm Console](${url})`])
  output({
    'run-arns': JSON.stringify([arn]),
    'run-count': 1,
    name: pool.name,
    availability: pool.availability
  })
  if (!producer.length) return
  // A cancelled job signals the step: stop the run here too, in case the group's cancel step never sees its ARN.
  const child = spawn(producer[0], producer.slice(1), {
    stdio: 'inherit',
    env: { ...env, RUN_ARNS: JSON.stringify([arn]), MOBILE_PHASE: 'produce' }
  })
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      child.kill(signal)
      try {
        awsCli(['stop-run', '--arn', arn])
      } catch {}
      process.exit(1)
    })
  process.exitCode = await new Promise((resolve) => child.on('close', (code) => resolve(code ?? 1)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(
    process.argv[2],
    process.env,
    process.argv.slice(process.argv.indexOf('--') + 1 || process.argv.length)
  )
