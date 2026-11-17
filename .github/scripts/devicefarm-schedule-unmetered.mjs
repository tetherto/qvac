#!/usr/bin/env node
// _mobile.yml's Device Farm scheduling: qvac-actions devicefarm-schedule-runs@0.6.0 (same plan, names and rollback)
// plus billing. Runs go UNMETERED first; a run with no free slot after CHECK_SECONDS is moved to METERED.

import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// A queued UNMETERED run reports SCHEDULING, like one that got a slot, so only these prove a slot.
const SLOT = ['PREPARING', 'RUNNING', 'COMPLETED', 'STOPPING']
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const safe = (s) => s.replace(/[^A-Za-z0-9]/g, '_')

export const awsCli = (args) =>
  JSON.parse(
    execFileSync('aws', ['devicefarm', ...args, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  )

// Unique per attempt, so stopping runs by name can never touch another attempt's runs.
export function runNameBase(env, event, appArn) {
  const id = appArn.split('/').pop()
  if (!id) throw new Error('app ARN must end with an upload id')
  const lead = env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? 'Manual' : 'PR'
  const num =
    env.GITHUB_EVENT_NAME === 'workflow_dispatch'
      ? env.GITHUB_RUN_NUMBER
      : event.pull_request?.number || env.GITHUB_RUN_NUMBER
  return `${lead}-${num}-${env.PLATFORM}-${env.GITHUB_RUN_ID}.${env.GITHUB_RUN_ATTEMPT}-${id}`
}

export function plan({ specs, models, operator, platform, base, maxDevices, maxRuns }) {
  if (!Array.isArray(specs) || !specs.length || !specs.every((s) => s.name && s.arn))
    throw new Error('specs must be a non-empty array with name and arn')
  if (!['EQUALS', 'CONTAINS'].includes(operator))
    throw new Error(`device-model-operator must be EQUALS or CONTAINS, got '${operator}'`)
  if (!models.length) throw new Error('no devices to schedule on')
  if (models.length > maxDevices)
    throw new Error(`${models.length} devices, the cap is ${maxDevices}`)
  if (specs.length * models.length > maxRuns)
    throw new Error(`${specs.length} specs x ${models.length} devices exceeds ${maxRuns} runs`)
  if (!['Android', 'iOS'].includes(platform))
    throw new Error(`platform must be Android or iOS, got '${platform}'`)
  const plat = platform === 'Android' ? 'ANDROID' : 'IOS'
  return specs.flatMap((s) =>
    models.map((m) => ({
      name: `${base}-${s.name}-${safe(m)}`,
      spec: s.arn,
      filter: {
        filters: [
          { attribute: 'PLATFORM', operator: 'EQUALS', values: [plat] },
          { attribute: 'MODEL', operator, values: [m] }
        ],
        maxDevices: 1
      }
    }))
  )
}

function scheduleOne(run, ctx, billing) {
  const arn = ctx.aws([
    'schedule-run',
    '--project-arn',
    ctx.project,
    '--app-arn',
    ctx.app,
    '--name',
    run.name,
    '--device-selection-configuration',
    JSON.stringify(run.filter),
    // JSON, not shorthand, so no value can add keys of its own.
    '--test',
    JSON.stringify({ type: ctx.testType, testPackageArn: ctx.testPackage, testSpecArn: run.spec }),
    '--configuration',
    JSON.stringify({ billingMethod: billing }),
    '--execution-configuration',
    JSON.stringify({ jobTimeoutMinutes: ctx.timeout })
  ]).run.arn
  ctx.created.push(arn)
  console.log(`${run.name} -> ${arn} (${billing})`)
  return arn
}

// A run created part way must be stopped, or it bills until its own timeout.
export function rollback(ctx) {
  const stop = (arn) => {
    try {
      ctx.aws(['stop-run', '--arn', arn])
    } catch {
      console.log(`::warning::could not stop ${arn}`)
    }
  }
  ctx.created.forEach(stop)
  // A run created whose ARN never came back is only findable by name.
  try {
    ctx
      .aws(['list-runs', '--arn', ctx.project])
      .runs.filter(
        (r) =>
          r.name.startsWith(ctx.base) &&
          !['COMPLETED', 'STOPPING'].includes(r.status) &&
          !ctx.created.includes(r.arn)
      )
      .forEach((r) => stop(r.arn))
  } catch {}
}

function toMetered(run, ctx) {
  try {
    ctx.aws(['stop-run', '--arn', run.arn])
  } catch {
    console.log(`::warning::Could not stop queued UNMETERED run ${run.name}; keeping it.`)
    return
  }
  run.arn = scheduleOne(run, ctx, 'METERED')
  run.billing = 'METERED'
}

export async function moveQueuedToMetered(runs, ctx, { checkSeconds, intervalMs, sleep, now }) {
  const deadline = now() + checkSeconds * 1000
  const last = new Map()
  let pending = [...runs]
  console.log(`Checking unmetered slots for ${pending.length} run(s)...`)
  while (pending.length) {
    const still = []
    for (const run of pending) {
      let status
      try {
        status = ctx.aws(['get-run', '--arn', run.arn]).run.status
      } catch {}
      if (SLOT.includes(status)) console.log(`  ${run.name}: unmetered slot taken (${status})`)
      else if (status === 'PENDING_CONCURRENCY') toMetered(run, ctx)
      else {
        still.push(run)
        if (status) last.set(run, status)
      }
    }
    pending = still
    if (!pending.length) return
    if (now() >= deadline) {
      for (const run of pending) {
        if (!last.has(run)) {
          console.log(`::warning::Could not read the status of ${run.name}; keeping it UNMETERED.`)
          continue
        }
        console.log(`  ${run.name}: still ${last.get(run)} after ${checkSeconds}s`)
        toMetered(run, ctx)
      }
      return
    }
    await sleep(intervalMs)
  }
}

const count = (name, value, fallback) => {
  const v = value || fallback
  if (!/^\d+$/.test(v || '')) throw new Error(`${name} '${value}' is not a number`)
  return Number(v)
}

export async function main(env, { aws = awsCli, sleep = pause, now = Date.now, onContext = () => {} } = {}) {
  if (!/^[A-Z_]+$/.test(env.TEST_TYPE || ''))
    throw new Error(`test-type '${env.TEST_TYPE}' is not a Device Farm test type`)
  const billing = (env.BILLING_METHOD || 'UNMETERED').toUpperCase()
  if (!['UNMETERED', 'METERED'].includes(billing))
    throw new Error(`billing method must be UNMETERED or METERED, got '${env.BILLING_METHOD}'`)
  const checkSeconds = count('check-seconds', env.CHECK_SECONDS, '180')
  const intervalMs = count('poll-seconds', env.POLL_SECONDS, '10') * 1000
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {}
  const base = runNameBase(env, event, env.APP_ARN)
  const models = [
    ...new Set(
      (env.DEVICES || '')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    )
  ].sort()
  const runs = plan({
    specs: JSON.parse(env.SPECS),
    models,
    operator: env.OPERATOR || 'CONTAINS',
    platform: env.PLATFORM,
    base,
    maxDevices: count('max-devices', env.MAX_DEVICES, '10'),
    maxRuns: count('max-runs', env.MAX_RUNS, '40')
  })
  const ctx = {
    aws,
    base,
    created: [],
    project: env.PROJECT_ARN,
    app: env.APP_ARN,
    testType: env.TEST_TYPE,
    testPackage: env.TEST_PACKAGE_ARN,
    timeout: count('job-timeout-minutes', env.TIMEOUT)
  }
  onContext(ctx)
  try {
    for (const run of runs) {
      run.arn = scheduleOne(run, ctx, billing)
      run.billing = billing
    }
    if (billing === 'UNMETERED') await moveQueuedToMetered(runs, ctx, { checkSeconds, intervalMs, sleep, now })
  } catch (e) {
    console.log(`::warning::Scheduling stopped part way; stopping ${ctx.created.length} created run(s)`)
    rollback(ctx)
    throw e
  }

  const arns = runs.map((r) => r.arn)
  const metered = runs.filter((r) => r.billing === 'METERED').length
  console.log(`Scheduled ${arns.length} run(s): ${arns.length - metered} UNMETERED, ${metered} METERED`)
  if (billing === 'UNMETERED' && metered)
    console.log(
      `::notice title=Device Farm billing::${metered} of ${arns.length} ${env.PLATFORM} run(s) moved to METERED: no free unmetered slot`
    )
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### Device Farm billing (${env.PLATFORM})\n\n| Billing | Runs |\n| --- | --- |\n| UNMETERED | ${arns.length - metered} |\n| METERED | ${metered} |\n\n`
    )
  appendFileSync(
    env.GITHUB_OUTPUT,
    `run-arns=${JSON.stringify(arns)}\nrun-count=${arns.length}\nmetered-count=${metered}\n`
  )
  return runs
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let ctx
  // A cancelled job signals the step before run-arns is published, so the cancel step would not see these runs.
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (ctx) rollback(ctx)
      process.exit(1)
    })
  await main(process.env, { onContext: (c) => (ctx = c) })
}
