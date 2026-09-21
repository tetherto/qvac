import { writeFileSync } from 'node:fs'
import { aggregateMetric } from './metrics'
import type {
  AggregateStats,
  MetricObservation,
  OpenAiApiCoverageSnapshot,
  RawDocument
} from './types'

function fmt(value: number | null, digits = 2): string {
  if (value === null) {
    return '—'
  }
  return value.toFixed(digits)
}

function fmtAggregateCounts(stats: AggregateStats): string {
  return `valid=${stats.nValid}, unavailable=${stats.nUnavailable}, failed=${stats.nFailed}, attempted=${stats.nAttempted}`
}

function fmtCoveragePercent(value: number): string {
  return value.toFixed(1)
}

function appendEndpointList(lines: string[], endpoints: string[]): void {
  if (endpoints.length === 0) {
    lines.push('- None')
    return
  }
  for (const endpoint of endpoints) {
    lines.push(`- \`${endpoint}\``)
  }
}

function appendOpenAiCoverage(
  lines: string[],
  coverage: OpenAiApiCoverageSnapshot | undefined
): void {
  lines.push('## OpenAI API capability coverage')
  lines.push('')
  lines.push(
    'Static route coverage only: route presence does not prove behavioral compatibility with OpenAI.'
  )
  lines.push('')

  if (coverage === undefined) {
    lines.push('Coverage snapshot: unavailable (not captured in this benchmark artifact).')
    lines.push('')
    return
  }

  if (coverage.status === 'unavailable') {
    lines.push('Coverage snapshot: unavailable.')
    for (const error of coverage.errors) {
      lines.push(`- ${error}`)
    }
    lines.push('')
    return
  }

  lines.push(`Source mode: ${coverage.source_mode}`)
  lines.push(`Captured: \`${coverage.captured_at}\``)
  lines.push(`Spec source: ${coverage.spec_source}`)
  lines.push(`Spec SHA-256: \`${coverage.spec_sha256}\``)
  lines.push(`OpenAI specification endpoints: ${coverage.spec_endpoint_count}`)
  lines.push(
    `QVAC router: ${coverage.router_source} (${coverage.router_implemented_count} implemented routes)`
  )
  lines.push('')
  lines.push(
    `Consumer-primary: ${coverage.consumer_primary.implemented} / ${coverage.consumer_primary.total} (${fmtCoveragePercent(coverage.consumer_primary.percent)}%)`
  )
  lines.push(
    `Primary-AI: ${coverage.primary_ai.implemented} / ${coverage.primary_ai.total} (${fmtCoveragePercent(coverage.primary_ai.percent)}%)`
  )
  lines.push('')
  lines.push('### Consumer-primary gaps')
  lines.push('')
  appendEndpointList(lines, coverage.consumer_primary.uncovered)
  lines.push('')
  lines.push('### Primary-AI gaps')
  lines.push('')
  appendEndpointList(lines, coverage.primary_ai.uncovered)
  lines.push('')
  lines.push('### QVAC-specific extensions')
  lines.push('')
  appendEndpointList(lines, coverage.extensions)
  lines.push('')
  if (coverage.warnings.length > 0) {
    lines.push('### Coverage warnings')
    lines.push('')
    for (const warning of coverage.warnings) {
      lines.push(`- ${warning}`)
    }
    lines.push('')
  }
}

export function writeOpenAiCoveragePreview(
  coverage: OpenAiApiCoverageSnapshot,
  path: string
): void {
  const lines = [
    '# OpenAI API capability coverage preview',
    '',
    'Preview only: no model, provider, performance benchmark, deployment, or publishing step ran.',
    ''
  ]
  appendOpenAiCoverage(lines, coverage)
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

export function writeReport(raw: RawDocument, path: string): void {
  const snapshot = raw.config_snapshot
  const providers = snapshot.providers.map((provider) => provider.id)
  const promptIds = snapshot.prompt_ids
  const measured = raw.runs.filter((run) => run.phase === 'measured')

  const lines: string[] = []
  lines.push('# OpenAI Server Performance Benchmark Report')
  lines.push('')
  lines.push(`Session: \`${raw.session_id}\``)
  lines.push(`Created: \`${raw.created_at}\``)
  lines.push(
    `Benchmark validity: ${raw.valid === false ? `INVALID (${(raw.invalid_reasons ?? []).join(', ')})` : 'VALID'}`
  )
  lines.push('')
  lines.push('## Executive summary')
  lines.push('')
  lines.push(
    'Client-side comparison of OpenAI-compatible `/v1/chat/completions` across qvac serve, Ollama, and LM Studio using one shared GGUF and one shared SDK path.'
  )
  if (raw.openai_api_coverage?.status === 'available') {
    lines.push(
      `Static QVAC route coverage: consumer-primary ${raw.openai_api_coverage.consumer_primary.implemented}/${raw.openai_api_coverage.consumer_primary.total} (${fmtCoveragePercent(raw.openai_api_coverage.consumer_primary.percent)}%); primary-AI ${raw.openai_api_coverage.primary_ai.implemented}/${raw.openai_api_coverage.primary_ai.total} (${fmtCoveragePercent(raw.openai_api_coverage.primary_ai.percent)}%).`
    )
  }
  lines.push('')
  lines.push('## Environment and exact revisions')
  lines.push('')
  lines.push(
    'The local source manifest is `environment.md`; protected full CI copies it to `results/environment.md` in the uploaded artifact.'
  )
  lines.push('')
  lines.push('## Model parity evidence')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(snapshot.model_parity ?? {}, null, 2))
  lines.push('```')
  lines.push('')
  lines.push('Provider-session parity:')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(raw.parity ?? {}, null, 2))
  lines.push('```')
  lines.push('')
  appendOpenAiCoverage(lines, raw.openai_api_coverage)
  lines.push('## Methodology and metric definitions')
  lines.push('')
  lines.push('- TTFT: request start → first non-empty `delta.content`')
  lines.push('- Total: request start → stream completion')
  lines.push(
    '- Client output TPS: `completion_tokens / total_s` (end to end; includes HTTP, queueing, prompt processing, and first-token time; not native decode TPS)'
  )
  lines.push(
    '- Effective prefill TPS (proxy): `prompt_tokens / ttft_s` (includes HTTP, queueing, template, prefill, first token; not native ppTPS)'
  )
  lines.push('- The configured GGUF SHA-256 is enforced before provider requests.')
  lines.push(
    '- Providers run sequentially; parity and measurements share one provider lifecycle session, with bounded stop cleanup after every start attempt.'
  )
  lines.push(
    '- Every aggregate reports valid, unavailable, failed, and attempted observation counts.'
  )
  lines.push(
    '- Protected live CI supplies runtime config and environment files from outside the checked-out repository.'
  )
  lines.push(`- Provider order: ${JSON.stringify(raw.provider_order)}`)
  lines.push(`- Cool-down between providers: ${snapshot.cooldown_seconds}s`)
  lines.push('')

  const metricKeys: Array<[string, string]> = [
    ['ttft_ms', 'TTFT (ms)'],
    ['total_ms', 'Total latency (ms)'],
    ['client_output_tps', 'Client output TPS']
  ]
  lines.push('## Median and IQR tables by prompt size')
  lines.push('')
  for (const [metricKey, title] of metricKeys) {
    lines.push(`### ${title}`)
    lines.push('')
    lines.push(`| Prompt | ${providers.join(' | ')} |`)
    lines.push(`|---| ${providers.map(() => '---').join(' | ')} |`)
    for (const promptId of promptIds) {
      const cells = [promptId]
      for (const provider of providers) {
        const observations: MetricObservation[] = measured
          .filter((run) => run.provider === provider && run.prompt_id === promptId)
          .map((run) => ({
            value: run.metrics[metricKey] ?? null,
            ok: run.ok
          }))
        const stats = aggregateMetric(observations)
        cells.push(`${fmt(stats.median)} (IQR ${fmt(stats.iqr)}; ${fmtAggregateCounts(stats)})`)
      }
      lines.push(`| ${cells.join(' | ')} |`)
    }
    lines.push('')
  }

  lines.push('## Effective prefill TPS (proxy)')
  lines.push('')
  lines.push('End-to-end proxy only. Do not interpret as native llama.cpp prefill throughput.')
  lines.push('')
  lines.push(`| Prompt | ${providers.join(' | ')} |`)
  lines.push(`|---| ${providers.map(() => '---').join(' | ')} |`)
  for (const promptId of promptIds) {
    const cells = [promptId]
    for (const provider of providers) {
      const observations: MetricObservation[] = measured
        .filter((run) => run.provider === provider && run.prompt_id === promptId)
        .map((run) => ({
          value: run.metrics['effective_prefill_tps'] ?? null,
          ok: run.ok
        }))
      const stats = aggregateMetric(observations)
      cells.push(`${fmt(stats.median)} (IQR ${fmt(stats.iqr)}; ${fmtAggregateCounts(stats)})`)
    }
    lines.push(`| ${cells.join(' | ')} |`)
  }
  lines.push('')

  lines.push('## Run variability and failures')
  lines.push('')
  const failures = measured.filter((run) => !run.ok)
  lines.push(`Measured failures: ${failures.length}`)
  lines.push('')
  if (failures.length === 0) {
    lines.push('- None')
  } else {
    for (const fail of failures) {
      lines.push(
        `- \`${fail.provider}\` \`${fail.prompt_id}\` #${fail.run_index}: ${JSON.stringify(fail.validation_reasons)} error=${fail.error}`
      )
    }
  }
  const orchestrationErrors = raw.orchestration_errors ?? []
  lines.push(`Lifecycle/orchestration failures: ${orchestrationErrors.length}`)
  for (const failure of orchestrationErrors) {
    lines.push(`- \`${failure.provider}\`: ${failure.message}`)
  }
  lines.push('')
  lines.push('## Interpretation')
  lines.push('')
  lines.push('_Fill in after reviewing medians, IQRs, and any failures._')
  lines.push('')
  lines.push('## Limitations')
  lines.push('')
  lines.push('- Single-host, single-model, sequential requests only.')
  lines.push('- Client output TPS is end-to-end client throughput, not native decode throughput.')
  lines.push(
    '- Provider blocks are ordered; cool-down reduces but does not erase thermal carryover.'
  )
  lines.push('- Effective prefill TPS is an end-to-end proxy, not native ppTPS.')
  lines.push(
    '- Prompt size labels are nominal; run-id prefixes slightly change prompt_tokens per run.'
  )
  lines.push(
    '- llama.cpp / runtime build differences across servers are part of the measured stack.'
  )
  lines.push('')
  lines.push('## Reproduction commands')
  lines.push('')
  lines.push('```bash')
  lines.push('cd packages/cli')
  lines.push('npm install')
  lines.push('export BENCHMARK_CONFIG_PATH=/absolute/path/to/benchmark.yaml')
  lines.push(
    'npx tsx benchmarks/serve-openai-providers/benchmark.ts digest --config "$BENCHMARK_CONFIG_PATH"'
  )
  lines.push(
    'npx tsx benchmarks/serve-openai-providers/benchmark.ts preflight --config "$BENCHMARK_CONFIG_PATH"'
  )
  lines.push(
    'npx tsx benchmarks/serve-openai-providers/benchmark.ts smoke --config "$BENCHMARK_CONFIG_PATH"'
  )
  lines.push(
    'npx tsx benchmarks/serve-openai-providers/benchmark.ts full --config "$BENCHMARK_CONFIG_PATH"'
  )
  lines.push('```')
  lines.push('')

  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}
