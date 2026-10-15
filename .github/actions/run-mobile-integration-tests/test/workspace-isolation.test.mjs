import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  COLLECT_ACTION,
  PERF_ACTION,
  makeWorkspace,
  readLines,
  runStep,
  stepCondition,
  stepStart,
  writeFixture,
} from './composite-step.mjs'

const RESET_STEP = 'Clear log directories left in the workspace by an earlier job'
const DOWNLOAD_STEP = 'Download Device Farm logs'
const EXTRACT_LOGS_STEP = 'Extract console logs'
const EXTRACT_PERF_STEP = 'Extract performance report from Device Farm logs'
const ALWAYS = 'always()'

const PLATFORM = 'Android'
const DEVICE_FARM_LOGS = 'devicefarm-logs'
const CONSOLE_LOGS = 'console-logs'
const PERF_REPORT = 'perf-report'
const PERF_RESULTS = 'perf-results-mobile'
const SUITE = 'Tests_Suite'
const LOGCAT = 'Logcat.logcat'
const PERF_REPORT_FILE = 'performance-report.json'
const PERF_SCRIPTS_DIR = 'addon/scripts/perf-report'
const ADDON_FILE = 'addon/package.json'
const RUN_NUMBER = '1'

const PREVIOUS_JOB = 'Manual-103-Android-385748006831-default-Samsung_Galaxy_S26_Ultra_Samsung_Galaxy_S26_Ultra'
const CURRENT_JOB = 'Manual-28-Android-385814644341-manual-Samsung_Galaxy_S25_Ultra_Samsung_Galaxy_S25_Ultra'

const PERF_ENV = {
  PLATFORM,
  LOG_DIR_NAME: DEVICE_FARM_LOGS,
  OUTPUT_DIR_NAME: PERF_RESULTS,
  FILTER: '',
  MERGE: 'false',
  UNZIP_CUSTOMER_ARTIFACTS: 'false',
}

const deviceFarmLogcat = (job) => join(DEVICE_FARM_LOGS, PLATFORM, job, SUITE, LOGCAT)
const consoleLogcatName = (job) => `${job}_${LOGCAT}`
const consoleLogcat = (job) => join(CONSOLE_LOGS, PLATFORM, consoleLogcatName(job))
const previousPerfReport = () => join(PERF_REPORT, PLATFORM, `${PREVIOUS_JOB}_perf-report.json`)
const previousPerfResult = () => join(PERF_RESULTS, PLATFORM, PREVIOUS_JOB, PERF_REPORT_FILE)
const exists = (workspace, relativePath) => existsSync(join(workspace, relativePath))

test('an earlier job\'s Device Farm logs are not uploaded as this run\'s console logs', (t) => {
  const context = makeWorkspace(t)
  const { workspace } = context
  writeFixture(workspace, deviceFarmLogcat(PREVIOUS_JOB))
  writeFixture(workspace, consoleLogcat(PREVIOUS_JOB))
  writeFixture(workspace, previousPerfReport())
  writeFixture(workspace, ADDON_FILE)

  runStep(COLLECT_ACTION, RESET_STEP, context)
  writeFixture(workspace, deviceFarmLogcat(CURRENT_JOB))
  runStep(COLLECT_ACTION, EXTRACT_LOGS_STEP, { ...context, env: { PLATFORM } })

  assert.deepEqual(readdirSync(join(workspace, CONSOLE_LOGS, PLATFORM)), [consoleLogcatName(CURRENT_JOB)])
  assert.equal(exists(workspace, previousPerfReport()), false)
  assert.equal(exists(workspace, ADDON_FILE), true)
})

test('the log directories are cleared before the download, even after a failed step', () => {
  const lines = readLines(COLLECT_ACTION)
  assert.ok(stepStart(lines, RESET_STEP) < stepStart(lines, DOWNLOAD_STEP))
  assert.equal(stepCondition(lines, RESET_STEP), ALWAYS)
})

test('an earlier job\'s perf report is not reported when this run produced none', (t) => {
  const context = makeWorkspace(t)
  const { workspace } = context
  writeFixture(workspace, previousPerfResult(), '{}')
  writeFixture(workspace, join(PERF_SCRIPTS_DIR, 'extract-from-log.js'))
  writeFixture(workspace, join(PERF_SCRIPTS_DIR, 'aggregate.js'))
  mkdirSync(join(workspace, DEVICE_FARM_LOGS, PLATFORM), { recursive: true })

  const outputs = runStep(PERF_ACTION, EXTRACT_PERF_STEP, {
    ...context,
    env: PERF_ENV,
    expressions: { 'github.run_number': RUN_NUMBER },
  })

  assert.match(outputs, /^extracted=false$/m)
  assert.equal(exists(workspace, previousPerfResult()), false)
})
