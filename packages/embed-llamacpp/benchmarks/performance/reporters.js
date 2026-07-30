'use strict'

const { truncateText } = require('./progress')

function tsFileStamp () {
  const d = new Date()
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

function cfgCell (value) {
  return value != null ? String(value) : ''
}

function toMarkdown (report) {
  const lines = []
  lines.push('# Embed Parameter Sweep Benchmark Report')
  lines.push('')
  lines.push(`- Started: ${report.startedAt}`)
  lines.push(`- Finished: ${report.finishedAt}`)
  lines.push(`- Repeats per case: ${report.repeats}`)
  lines.push('- Sweep mode: full-grid')
  lines.push('')
  for (const model of report.models) {
    lines.push(`## Model: ${model.modelId}`)
    lines.push('| Quantization | Device | Batch Size | Ctx | Sentences | No Mmap | Flash Attn | Status | Load ms | Run ms (avg per repeat) | Unload ms | ppTPS (mean) | Error |')
    lines.push('|---|---|---:|---:|---:|---|---|---|---:|---:|---:|---:|---|')
    for (const item of model.cases) {
      const metrics = item.metrics || {}
      const runtimeConfig = item.runtimeConfig || {}
      const derived = item.derived || {}
      const quantizationCell = cfgCell(item.quantization)
      const deviceCell = cfgCell(runtimeConfig.device)
      const batchSizeCell = cfgCell(runtimeConfig.batchSize)
      const ctxCell = cfgCell(derived.ctx ?? runtimeConfig.ctx)
      const sentencesCell = cfgCell(derived.nSentences)
      const noMmapCell = runtimeConfig.noMmap ? 'on' : 'off'
      const flashAttnCell = cfgCell(runtimeConfig.flashAttn)
      const statusCell = item.status ?? ''
      const errorCell = item.error && item.error.message
        ? truncateText(item.error.message, 120)
        : ''
      lines.push(
        `| ${quantizationCell} | ${deviceCell} | ${batchSizeCell} | ${ctxCell} | ${sentencesCell} | ${noMmapCell} | ${flashAttnCell}` +
        ` | ${statusCell} | ${metrics.loadMs ?? ''}` +
        ` | ${metrics.runMs ?? ''}` +
        ` | ${metrics.unloadMs ?? ''}` +
        ` | ${metrics.tps ?? ''}` +
        ` | ${errorCell} |`
      )
    }
    lines.push('')
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

// Per-run JSON the renderer ingests: models[].cases[], each case carrying
// caseId/parameter/quantization/modelName/runtimeConfig/derived/metrics/status/
// repeatsAttempted/repeatsSucceeded/error.
function toReportJson (report) {
  return {
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    repeats: report.repeats,
    coverage: report.coverage,
    models: report.models.map((model) => ({
      modelId: model.modelId,
      source: model.source,
      modelDir: model.modelDir,
      cases: model.cases.map((item) => ({
        caseId: item.caseId,
        parameter: item.parameter,
        quantization: item.quantization,
        modelName: item.modelName,
        runtimeConfig: item.runtimeConfig,
        derived: item.derived,
        metrics: item.metrics,
        status: item.status,
        repeatsAttempted: item.repeatsAttempted,
        repeatsSucceeded: item.repeatsSucceeded,
        error: item.error
      }))
    }))
  }
}

function toJsonLines (report) {
  const lines = []
  for (const model of report.models) {
    for (const item of model.cases) {
      lines.push(JSON.stringify({
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        repeats: report.repeats,
        modelId: model.modelId,
        source: model.source,
        modelDir: model.modelDir,
        caseId: item.caseId,
        parameter: item.parameter,
        quantization: item.quantization,
        modelName: item.modelName,
        runtimeConfig: item.runtimeConfig,
        derived: item.derived,
        metrics: item.metrics,
        status: item.status,
        repeatsAttempted: item.repeatsAttempted,
        repeatsSucceeded: item.repeatsSucceeded,
        error: item.error
      }))
    }
  }
  return `${lines.join('\n')}\n`
}

module.exports = {
  tsFileStamp,
  toMarkdown,
  toReportJson,
  toJsonLines
}
