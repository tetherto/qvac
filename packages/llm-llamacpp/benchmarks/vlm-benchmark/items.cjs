'use strict'
// Fixture item selection for the Node-side legs (server-runner.cjs, run-local.cjs).
// Same precedence as harness.cjs selectedItems(): preset.ids > tasks > preset.tasks >
// the default scenario's tasks, preset.maxTasks distinct tasks, per-task caps from
// preset.taskSamples else samples. harness.cjs keeps its own copy (it runs under Bare
// and is bundled for mobile); keep the two in step.

const fixture = require('./fixture.data.cjs')
const config = require('./config.cjs')

// Per-task output-token caps; must match TASK_NPREDICT in harness.cjs.
const TASK_NPREDICT = { 'ocr-page': 768, 'ocr-small': 96 }
const DEFAULT_NPREDICT = 128
const nPredictFor = task => TASK_NPREDICT[task] || DEFAULT_NPREDICT

// Scored-prediction char caps; must match TASK_PRED_CAP in harness.cjs.
const TASK_PRED_CAP = { 'ocr-page': 2000 }
const DEFAULT_PRED_CAP = 600
const predCapFor = task => TASK_PRED_CAP[task] || DEFAULT_PRED_CAP

function selectItems (preset, { samples, tasks } = {}) {
  if (preset.ids) {
    const want = new Set(preset.ids)
    return fixture.items.filter(it => want.has(it.id))
  }
  const scenario = (config.scenarios || {})[config.defaultScenario || 'default'] || {}
  const taskList = tasks && tasks.length ? tasks : (preset.tasks || scenario.tasks || null)
  const perTask = samples || preset.samplesPerTask || 5
  const seen = {}
  return fixture.items.filter(it => {
    if (taskList && !taskList.includes(it.task)) return false
    if (!(it.task in seen) && preset.maxTasks && Object.keys(seen).length >= preset.maxTasks) return false
    seen[it.task] = (seen[it.task] || 0) + 1
    const cap = (preset.taskSamples && preset.taskSamples[it.task] != null) ? preset.taskSamples[it.task] : perTask
    return seen[it.task] <= cap
  })
}

module.exports = { selectItems, nPredictFor, predCapFor }
