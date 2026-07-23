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

// Baseline rows render every config column as 'default'; otherwise show the
// runtime value (stringified) or blank when unset.
function cfgCell (isBaseline, value) {
  if (isBaseline) return 'default'
  return value != null ? String(value) : ''
}

function compactPromptErrors (promptResults) {
  if (!Array.isArray(promptResults)) return []
  const out = []
  for (const item of promptResults) {
    if (!item || !item.error) continue
    out.push({
      promptId: item.promptId,
      error: truncateText(item.error, 300),
      vramError: Boolean(item.vramError)
    })
  }
  return out
}

function toMarkdown (report) {
  const lines = []
  lines.push('# LLM Parameter Sweep Benchmark Report')
  lines.push('')
  lines.push(`- Started: ${report.startedAt}`)
  lines.push(`- Finished: ${report.finishedAt}`)
  lines.push(`- Repeats per case: ${report.repeats}`)
  lines.push('- Sweep mode: full-grid')
  lines.push(`- Prompts: ${report.promptsCount}`)
  if (report.totalCases != null) lines.push(`- Cases: ${report.totalCases}`)
  if (report.totalPlannedRuns != null) lines.push(`- Planned runs: ${report.totalPlannedRuns}`)
  if (report.totalCompletedRuns != null) lines.push(`- Completed runs: ${report.totalCompletedRuns}`)
  lines.push(`- Case records: ${report.jsonlPath}`)
  if (report.sweep) lines.push(`- Sweep dimensions: ${JSON.stringify(report.sweep)}`)
  lines.push('')
  lines.push('')
  for (const model of report.models) {
    lines.push(`## Model: ${model.modelId}`)
    lines.push('| Quantization | Reasoning Budget | Device | Ctx Size | Batch Size | Ubatch Size | Flash Attn | Threads | Cache K | Cache V | Prompt Case | Status | TTFT Mean | TTFT Std | TPS Mean | TPS Std | ppTPS Mean | ppTPS Std | Load Mean | Load Std | Run Mean | Run Std | Unload Mean | Unload Std | Prompt Tokens | Generated Tokens | Quality Match | Error |')
    lines.push('|---|---|---|---:|---:|---:|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|')
    for (const item of model.cases) {
      const runtimeConfig = item.runtimeConfig || {}
      const quantizationCell = cfgCell(item.isBaseline, item.quantization)
      const rbCell = cfgCell(item.isBaseline, runtimeConfig['reasoning-budget'])
      const deviceCell = cfgCell(item.isBaseline, runtimeConfig.device)
      const ctxSizeCell = cfgCell(item.isBaseline, runtimeConfig['ctx-size'])
      const batchSizeCell = cfgCell(item.isBaseline, runtimeConfig['batch-size'])
      const ubatchSizeCell = cfgCell(item.isBaseline, runtimeConfig['ubatch-size'])
      const flashAttnCell = cfgCell(item.isBaseline, runtimeConfig['flash-attn'])
      const threadsCell = cfgCell(item.isBaseline, runtimeConfig.threads)
      const cacheKCell = cfgCell(item.isBaseline, runtimeConfig['cache-type-k'])
      const cacheVCell = cfgCell(item.isBaseline, runtimeConfig['cache-type-v'])
      const errorCell = item.error && item.error.message
        ? truncateText(item.error.message, 120)
        : ''
      lines.push(
        `| ${quantizationCell} | ${rbCell} | ${deviceCell} | ${ctxSizeCell} | ${batchSizeCell} | ${ubatchSizeCell} | ${flashAttnCell} | ${threadsCell} | ${cacheKCell} | ${cacheVCell} | ${item.promptCase ?? ''} | ${item.status ?? ''}` +
        ` | ${item.metrics?.ttftMsMean ?? ''} | ${item.metrics?.ttftMsStd ?? ''}` +
        ` | ${item.metrics?.tpsMean ?? ''} | ${item.metrics?.tpsStd ?? ''}` +
        ` | ${item.metrics?.ppTpsMean ?? ''} | ${item.metrics?.ppTpsStd ?? ''}` +
        ` | ${item.metrics?.loadMsMean ?? ''} | ${item.metrics?.loadMsStd ?? ''}` +
        ` | ${item.metrics?.runMsMean ?? ''} | ${item.metrics?.runMsStd ?? ''}` +
        ` | ${item.metrics?.unloadMsMean ?? ''} | ${item.metrics?.unloadMsStd ?? ''}` +
        ` | ${item.metrics?.promptTokens ?? ''} | ${item.metrics?.generatedTokens ?? ''}` +
        ` | ${item.qualityMatch != null ? item.qualityMatch.toFixed(3) : ''} | ${errorCell} |`
      )
    }
    lines.push('')
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

module.exports = {
  tsFileStamp,
  compactPromptErrors,
  toMarkdown
}
