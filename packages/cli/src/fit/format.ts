import type { ModelFitResponse } from '@/serve/core/fit'
import type { CatalogMiss, CatalogReport } from '@/fit/catalog'

const FIT_REJECTED = 'MODEL_FIT_REJECTED'

export const FIT_REJECTION_HINT =
  'A companion file (projector, VAE, codec) is judged through the model that loads it. A model made of several parts needs its companion files and settings, passed with --set or through a serve alias.'

/** The hint for an error the engine fitter rejected the load with, if it is one. */
export function fitRejectionHint(error: unknown): string | undefined {
  return error instanceof Error && error.name === FIT_REJECTED ? FIT_REJECTION_HINT : undefined
}

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
  const why = model.reason === undefined ? '' : ` — ${model.reason}`
  return [
    `${head}${judgedAt(model)}${why}`,
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
  const rejected = report.withoutVerdict.filter((entry) => entry.code === FIT_REJECTED)
  const others = report.withoutVerdict.filter((entry) => entry.code !== FIT_REJECTED)
  lines.push('', `Models without a verdict (${others.length})`, ...others.map(missLine))
  if (rejected.length > 0) {
    lines.push('', `Rejected by the engine fitter (${rejected.length})`, `  ${FIT_REJECTION_HINT}`)
    lines.push(...rejected.map(missLine))
  }
  return lines.join('\n')
}

function missLine(entry: CatalogMiss): string {
  const code = entry.code === undefined || entry.code === FIT_REJECTED ? '' : `${entry.code}: `
  return `  ? ${entry.model}  ${code}${entry.reason}`
}
