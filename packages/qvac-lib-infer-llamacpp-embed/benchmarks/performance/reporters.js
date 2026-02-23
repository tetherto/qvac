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

function toMarkdown (report) {
  const lines = []
  lines.push('# Embed Parameter Sweep Benchmark Report')
  lines.push('')
  lines.push(`- Started: ${report.startedAt}`)
  lines.push(`- Finished: ${report.finishedAt}`)
  lines.push(`- Repeats per case: ${report.repeats}`)
  lines.push(`- Sweep mode: full-grid`)
  lines.push('')
  for (const model of report.models) {
    lines.push(`## Model: ${model.modelId}`)
    lines.push('| Quantization | Device | Batch Size | Input | No Mmap | Flash Attn | Status | Load ms | Run ms (avg per repeat) | Unload ms | TPS (mean) | Avg CosSim | Error |')
    lines.push('|---|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---|')
    for (const item of model.cases) {
      const metrics = item.metrics || {}
      const runtimeConfig = item.runtimeConfig
      const cos = item.similarity ? item.similarity.avg : ''
      const quantizationCell = item.isBaseline ? 'default' : item.quantization
      const deviceCell = item.isBaseline ? 'default' : String(runtimeConfig.device)
      const batchSizeCell = item.isBaseline ? 'default' : String(runtimeConfig.batchSize)
      const inputCell = item.inputMode || 'single'
      const noMmapCell = item.isBaseline
        ? 'default'
        : (runtimeConfig.noMmap ? 'on' : 'off')
      const flashAttnCell = item.isBaseline
        ? 'default'
        : String(runtimeConfig.flashAttn)
      const statusCell = item.status
      const errorCell = item.error ? truncateText(item.error.message, 120) : ''
      lines.push(
        `| ${quantizationCell} | ${deviceCell} | ${batchSizeCell} | ${inputCell} | ${noMmapCell} | ${flashAttnCell}` +
        ` | ${statusCell} | ${metrics.loadMs ?? ''}` +
        ` | ${metrics.runMs ?? ''}` +
        ` | ${metrics.unloadMs ?? ''}` +
        ` | ${metrics.tps ?? ''}` +
        ` | ${cos} | ${errorCell} |`
      )
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
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
        inputMode: item.inputMode,
        runtimeConfig: item.runtimeConfig,
        isBaseline: item.isBaseline,
        metrics: item.metrics,
        similarity: item.similarity,
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
  toJsonLines
}
