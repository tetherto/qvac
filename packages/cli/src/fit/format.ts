import type { ModelFitResponse } from '@/serve/core/fit'
import type { CatalogReport } from '@/fit/catalog'

type Verdict = ModelFitResponse['verdict']
type Model = ModelFitResponse['models'][number]
type Pool = ModelFitResponse['pools'][number]
type Device = Model['devices'][number]

const MARK: Record<Verdict, string> = { fits: '✔', 'does-not-fit': '✖', unknown: '?' }

export function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function memory(entry: Device | Pool): string {
  const free = entry.freeBytes === undefined ? 'no free figure' : `of ${gib(entry.freeBytes)} free`
  return `${gib(entry.usedBytes).padStart(10)} ${free}`
}

/** What the model was judged at: the context and GPU layers of a llama.cpp verdict. */
function judgedAt(model: Pick<Model, 'stats'>): string {
  const { stats } = model
  if (!('ctxSize' in stats)) return ''
  return ` · context ${stats.ctxSize} · ${stats.gpuLayers} GPU layers`
}

function modelBlock(model: Model): string[] {
  const head = `${MARK[model.status]} ${model.model}  ${model.status}`
  if (model.status === 'unknown') return [`${head} — ${model.reason ?? 'no reason given'}`]
  return [
    `${head}${judgedAt(model)}`,
    ...model.devices.map((device) => `    ${device.name.padEnd(10)}${memory(device)}`)
  ]
}

export function formatFit(result: ModelFitResponse): string {
  const lines = result.models.flatMap(modelBlock)
  const label = result.models.length === 1 ? 'Verdict' : 'Loaded together'
  lines.push('', `${MARK[result.verdict]} ${label}: ${result.verdict}`)
  for (const pool of result.pools) lines.push(`    ${pool.id.padEnd(10)}${memory(pool)}`)
  return lines.join('\n')
}

export function formatCatalog(report: CatalogReport): string {
  const lines = [`Models with a verdict (${report.withVerdict.length})`]
  for (const entry of report.withVerdict) {
    const used = entry.pools.reduce((sum, pool) => sum + pool.usedBytes, 0)
    lines.push(
      `  ${MARK[entry.verdict]} ${entry.model}  ${entry.verdict}  ${gib(used)}${judgedAt(entry)}`
    )
  }
  lines.push('', `Models without a verdict (${report.withoutVerdict.length})`)
  for (const entry of report.withoutVerdict) {
    const code = entry.code === undefined ? '' : `${entry.code}: `
    lines.push(`  ? ${entry.model}  ${code}${entry.reason}`)
  }
  return lines.join('\n')
}
