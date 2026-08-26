import { profilerExportSchema, type ProfilerExport } from '../schemas/messages.js'

export interface ParsedProfilerExport {
  config: {
    enabled?: boolean
    mode?: string
    includeServerBreakdown?: boolean
  }
  aggregates: Record<string, { count: number; min: number; max: number; avg: number; sum: number }>
  recentEvents: Array<{
    op?: string
    kind?: string
    phase?: string
    ms?: number
    tags?: Record<string, string>
    gauges?: Record<string, number>
  }>
}

export function parseProfilerExport(data: unknown): ParsedProfilerExport | null {
  const result = profilerExportSchema.safeParse(data)
  if (!result.success) return null

  const { config, aggregates, recentEvents } = result.data
  if (!config || !aggregates) return null

  const parsedAggregates: ParsedProfilerExport['aggregates'] = {}
  for (const [key, stats] of Object.entries(aggregates)) {
    parsedAggregates[key] = {
      count: stats.count,
      min: stats.min,
      max: stats.max,
      avg: stats.avg,
      sum: stats.sum ?? stats.total ?? 0
    }
  }

  return {
    config: {
      enabled: config.enabled,
      mode: config.mode,
      includeServerBreakdown: config.includeServerBreakdown
    },
    aggregates: parsedAggregates,
    recentEvents: (recentEvents ?? []) as ParsedProfilerExport['recentEvents']
  }
}

export function getMetricCount(data: unknown): number | undefined {
  const result = profilerExportSchema.safeParse(data)
  if (!result.success) return undefined
  return Object.keys(result.data.aggregates ?? {}).length
}

export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function renderRawProfilerFallback(
  consumerId: string,
  data: ProfilerExport,
  metadataHtml = ''
): string {
  const shortId = consumerId.split('-').slice(1, 3).join('-')
  return `
  <div class="consumer-section">
    <div class="consumer-header">
      <h3>📊 ${shortId}</h3>
      <div class="consumer-stats"><span style="color: #f59e0b;">Unknown profiler format</span></div>
    </div>
    ${metadataHtml}
    <details>
      <summary style="cursor: pointer; color: #6b7280;">View raw JSON</summary>
      <pre style="background: #f3f4f6; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px;">${escapeHtml(JSON.stringify(data, null, 2))}</pre>
    </details>
  </div>`
}
