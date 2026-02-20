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
  lines.push('> Runtime memory currently reports process-level JS memory only.')
  lines.push('')
  lines.push('### Metric Notes')
  lines.push('')
  lines.push('- Mean (`*Mean`): arithmetic average across successful repeats for a case/prompt.')
  lines.push('- Std (`*Std`): standard deviation across successful repeats (higher means less stable runs).')
  lines.push('- `runMs`: end-to-end inference duration for the prompt run (excluding model load/unload lifecycle).')
  lines.push('- `ttftMs`: time to first generated token.')
  lines.push('- `tps`: generated tokens per second.')
  lines.push('- `promptTokens`: number of input tokens processed.')
  lines.push('- `generatedTokens`: number of tokens produced by generation.')
  lines.push('- `loadMs` / `unloadMs`: model load/unload lifecycle time measured per case.')
  lines.push('- `RSS` (`rssMb`): resident set size used by the process (total physical memory footprint).')
  lines.push('- `Heap` (`heapUsedMb`): JavaScript heap memory currently in use.')
  lines.push('- `External` (`externalMb`): memory used by external/native objects tracked by the JS runtime.')
  lines.push('')
  for (const model of report.models) {
    lines.push(`## Model: ${model.modelId}`)
    lines.push('| Quantization | Device | Ctx Size | Batch Size | Ubatch Size | No Mmap | Flash Attn | Threads | Cache K | Cache V | Prompt Case | Status | Load Mean | Load Std | Run Mean | Run Std | TTFT Mean | TTFT Std | TPS Mean | TPS Std | Unload Mean | Unload Std | Prompt Tokens Mean | Prompt Tokens Std | Generated Tokens Mean | Generated Tokens Std | RSS Mean | RSS Std | Heap Mean | Heap Std | External Mean | External Std | Quality Match | Error |')
    lines.push('|---|---|---:|---:|---:|---|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|')
    for (const item of model.cases) {
      const runtimeConfig = item.runtimeConfig || {}
      const quality = item.qualityMatch != null ? item.qualityMatch.toFixed(3) : ''
      const quantizationCell = item.isBaseline ? 'default' : (item.quantization ?? '')
      const deviceCell = item.isBaseline ? 'default' : (runtimeConfig.device != null ? String(runtimeConfig.device) : '')
      const ctxSizeCell = item.isBaseline ? 'default' : (runtimeConfig['ctx-size'] != null ? String(runtimeConfig['ctx-size']) : '')
      const batchSizeCell = item.isBaseline ? 'default' : (runtimeConfig['batch-size'] != null ? String(runtimeConfig['batch-size']) : '')
      const ubatchSizeCell = item.isBaseline ? 'default' : (runtimeConfig['ubatch-size'] != null ? String(runtimeConfig['ubatch-size']) : '')
      const noMmapCell = item.isBaseline
        ? 'default'
        : (runtimeConfig['no-mmap'] ? 'on' : 'off')
      const flashAttnCell = item.isBaseline
        ? 'default'
        : (runtimeConfig['flash-attn'] != null ? String(runtimeConfig['flash-attn']) : '')
      const threadsCell = item.isBaseline ? 'default' : (runtimeConfig.threads != null ? String(runtimeConfig.threads) : '')
      const cacheKCell = item.isBaseline ? 'default' : (runtimeConfig['cache-type-k'] != null ? String(runtimeConfig['cache-type-k']) : '')
      const cacheVCell = item.isBaseline ? 'default' : (runtimeConfig['cache-type-v'] != null ? String(runtimeConfig['cache-type-v']) : '')
      const runtimeMemory = item.metrics && item.metrics.runtimeMemory
        ? item.metrics.runtimeMemory
        : {}
      const errorCell = item.error && item.error.message
        ? truncateText(item.error.message, 120)
        : ''
      lines.push(
        `| ${quantizationCell} | ${deviceCell} | ${ctxSizeCell} | ${batchSizeCell} | ${ubatchSizeCell} | ${noMmapCell} | ${flashAttnCell} | ${threadsCell} | ${cacheKCell} | ${cacheVCell} | ${item.promptCase ?? ''} | ${item.status ?? ''}` +
        ` | ${item.metrics?.loadMsMean ?? ''} | ${item.metrics?.loadMsStd ?? ''}` +
        ` | ${item.metrics?.runMsMean ?? ''} | ${item.metrics?.runMsStd ?? ''}` +
        ` | ${item.metrics?.ttftMsMean ?? ''} | ${item.metrics?.ttftMsStd ?? ''}` +
        ` | ${item.metrics?.tpsMean ?? ''} | ${item.metrics?.tpsStd ?? ''}` +
        ` | ${item.metrics?.unloadMsMean ?? ''} | ${item.metrics?.unloadMsStd ?? ''}` +
        ` | ${item.metrics?.promptTokensMean ?? ''} | ${item.metrics?.promptTokensStd ?? ''}` +
        ` | ${item.metrics?.generatedTokensMean ?? ''} | ${item.metrics?.generatedTokensStd ?? ''}` +
        ` | ${runtimeMemory?.rssMbMean ?? ''} | ${runtimeMemory?.rssMbStd ?? ''}` +
        ` | ${runtimeMemory?.heapUsedMbMean ?? ''} | ${runtimeMemory?.heapUsedMbStd ?? ''}` +
        ` | ${runtimeMemory?.externalMbMean ?? ''} | ${runtimeMemory?.externalMbStd ?? ''}` +
        ` | ${quality} | ${errorCell} |`
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
