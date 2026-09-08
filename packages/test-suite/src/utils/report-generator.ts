import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { ProfilerExport } from '../schemas/messages.js'
import { parseProfilerExport, renderRawProfilerFallback, escapeHtml } from './profiler-adapter.js'
import type { MemorySummary, MemoryUnit } from './memory-aggregator.js'

export interface ReportTestResult {
  testId: string
  /** Unique test-instance ID (matches per-test memory window). */
  uniqueTestId?: string
  consumerId: string
  outcome: 'success' | 'failure' | 'skipped'
  duration: number
  error?: string
  output?: string
  expected?: string
  actual?: string
  suites?: string[]
  /**
   * Test's declared metadata.category. Preferred over deriving from testId
   * via prefix-split, which mangles multi-word categories like "wrong-model"
   * into "wrong".
   */
  category?: string
  /** True when a diagnostic reload retry was executed after the first failure. */
  retried?: boolean
  /** Whether the retry attempt passed. Set only when retried is true. */
  retryPassed?: boolean
  /** Output/error from the retry attempt. Set only when retried is true. */
  retryOutput?: string
}

export interface ReportConsumerInfo {
  consumerId: string
  platform: string
}

export interface ReportProfilingData {
  consumerId: string
  profilerExport: ProfilerExport
  kind?: 'checkpoint' | 'final'
  sequence?: number
  timestamp?: string
  receivedAt?: number
  incomplete?: boolean
}

export interface ReportData {
  runId: string
  completedTests: ReportTestResult[]
  consumers: Map<string, ReportConsumerInfo>
  startTime: number
  profilingData?: ReportProfilingData[]
  /**
   * Optional aggregated in-app memory data, one entry per metric series (e.g.
   * resident memory, USS, mmap region count). The report omits the
   * Memory tab when absent or empty.
   */
  memorySummaries?: MemorySummary[]
  /** Override the default `reports/` output directory (used by run:local). */
  reportDir?: string
}

// Collect system information for the report
const systemInfo = {
  hostname: os.hostname(),
  platform: os.platform(),
  platformVersion: os.release(),
  arch: os.arch(),
  cpus: os.cpus()[0]?.model || 'Unknown',
  cpuCores: os.cpus().length,
  totalMemoryGB: (os.totalmem() / 1024 ** 3).toFixed(2),
  freeMemoryGB: (os.freemem() / 1024 ** 3).toFixed(2),
  nodeVersion: process.version
}

function buildTestDetailsHtml(
  test: ReportTestResult,
  opts: { includeConsumer?: boolean } = {}
): string {
  const errorMsg = test.error || 'No error message'
  const outputMsg = test.output || 'No output'

  let html = '<div class="error-details">'

  if (test.retried) {
    const escapedFirst = escapeHtml(errorMsg)
    const escapedRetry = escapeHtml(test.retryOutput || '(no output)')
    const attempt2Class = test.retryPassed ? 'attempt-pass' : 'attempt-fail-retry'
    const attempt2Label = test.retryPassed
      ? '✓ Attempt 2 — PASSED after reload'
      : '✗ Attempt 2 — FAILED after reload'

    html += '<div class="retry-attempt-box">'
    html += '<div class="retry-attempt-header attempt-fail">✗ Attempt 1 — Failed</div>'
    html += '<div class="retry-attempt-body">' + escapedFirst + '</div>'
    html += '</div>'

    html += '<div class="retry-attempt-box">'
    html += '<div class="retry-attempt-header ' + attempt2Class + '">' + attempt2Label + '</div>'
    html += '<div class="retry-attempt-body">' + escapedRetry + '</div>'
    html += '</div>'
  } else {
    const escapedError = escapeHtml(errorMsg)
    const escapedOutput = escapeHtml(outputMsg)

    html += '<div class="error-label">❌ Failure Analysis</div>'

    if (test.expected && test.actual) {
      const escapedExpected = escapeHtml(test.expected)
      const escapedActual = escapeHtml(test.actual)
      html += '<div class="comparison-container">'
      html +=
        '<div class="expected-box"><div class="box-label">✅ Expected</div><div class="box-content">' +
        escapedExpected +
        '</div></div>'
      html +=
        '<div class="actual-box"><div class="box-label">❌ Actual</div><div class="box-content">' +
        escapedActual +
        '</div></div>'
      html += '</div>'
    }

    html += '<div class="log-section"><div class="log-header">📋 Error Message</div>'
    html += '<div class="output-text">' + escapedError + '</div></div>'

    if (outputMsg !== errorMsg && outputMsg !== 'No output') {
      html += '<div class="log-section"><div class="log-header">📄 Test Output / Log</div>'
      html += '<div class="output-text">' + escapedOutput + '</div></div>'
    }
  }

  html += '<div class="log-section"><div class="log-header">ℹ️  Test Information</div>'
  html += '<div class="output-text">'
  if (opts.includeConsumer) {
    html += '<strong>Consumer:</strong> ' + escapeHtml(test.consumerId) + '<br>'
  }
  html += '<strong>Duration:</strong> ' + (test.duration / 1000).toFixed(2) + 's'
  html += '</div></div>'
  html += '</div>'

  return html
}

function renderRetryBadge(test: ReportTestResult): string {
  if (!test.retried) return ''
  return (
    ' <span class="badge ' +
    (test.retryPassed ? 'retry-pass' : 'retry-fail') +
    '">↩ ' +
    (test.retryPassed ? 'RETRY:✓' : 'RETRY:✗') +
    '</span>'
  )
}

function testRowClass(test: ReportTestResult): string {
  if (test.outcome !== 'failure') return ''
  if (test.retried) return test.retryPassed ? 'retry-pass-highlight' : 'retry-fail-highlight'
  return 'failure-highlight'
}

export function generateHtmlReport(data: ReportData): string {
  const outDir = data.reportDir || 'reports'
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true })
  }

  // Try filename with run ID first
  let filename = path.join(outDir, `batch-report-${data.runId}.html`)

  // If file exists, add timestamp to make it unique
  if (fs.existsSync(filename)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    filename = path.join(outDir, `batch-report-${data.runId}-${timestamp}.html`)
  }

  const elapsed = data.startTime > 0 ? (Date.now() - data.startTime) / 1000 : 0
  const successCount = data.completedTests.filter((t) => t.outcome === 'success').length
  const failureCount = data.completedTests.filter((t) => t.outcome === 'failure').length
  const skippedCount = data.completedTests.filter((t) => t.outcome === 'skipped').length
  const retriedCount = data.completedTests.filter((t) => t.retried).length
  const retriedPassedCount = data.completedTests.filter((t) => t.retried && t.retryPassed).length
  const retriedFailedCount = retriedCount - retriedPassedCount
  const nonSkipped = data.completedTests.length - skippedCount
  const successRate = nonSkipped > 0 ? ((successCount / nonSkipped) * 100).toFixed(1) : '0.0'

  // Group tests by consumer
  const testsByConsumer = new Map<string, ReportTestResult[]>()
  for (const test of data.completedTests) {
    if (!testsByConsumer.has(test.consumerId)) {
      testsByConsumer.set(test.consumerId, [])
    }
    testsByConsumer.get(test.consumerId)!.push(test)
  }

  // Group tests by category. Prefer the test's declared metadata.category
  // (passed through ReportTestResult.category by the orchestrator) over
  // the fallback testId-prefix split.
  const testsByCategory = new Map<string, ReportTestResult[]>()
  for (const test of data.completedTests) {
    const category =
      test.category ?? (test.testId.includes('-') ? test.testId.split('-')[0] : test.testId)
    if (!testsByCategory.has(category)) {
      testsByCategory.set(category, [])
    }
    testsByCategory.get(category)!.push(test)
  }

  // Group tests by suite
  const testsBySuite = new Map<string, ReportTestResult[]>()
  for (const test of data.completedTests) {
    if (!test.suites) continue
    for (const suite of test.suites) {
      if (!testsBySuite.has(suite)) {
        testsBySuite.set(suite, [])
      }
      testsBySuite.get(suite)!.push(test)
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>QVAC Batch Test Report - ${data.runId} - ${new Date().toLocaleString()}</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { 
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
			background: #f5f5f5;
			padding: 20px;
		}
		.container { max-width: 1400px; margin: 0 auto; }
		.header {
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			color: white;
			padding: 30px;
			border-radius: 10px;
			margin-bottom: 20px;
			box-shadow: 0 4px 6px rgba(0,0,0,0.1);
		}
		.header h1 { margin-bottom: 10px; }
		.header p { opacity: 0.9; }
		.stats {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
			gap: 15px;
			margin-bottom: 20px;
		}
		.stat-card {
			background: white;
			padding: 20px;
			border-radius: 8px;
			box-shadow: 0 2px 4px rgba(0,0,0,0.1);
		}
		.stat-card h3 { color: #666; font-size: 14px; margin-bottom: 5px; }
		.stat-card .value { font-size: 32px; font-weight: bold; }
		.stat-card.success .value { color: #10b981; }
		.stat-card.failure .value { color: #ef4444; }
		.stat-card.info .value { color: #3b82f6; }
		.section {
			background: white;
			padding: 25px;
			border-radius: 8px;
			margin-bottom: 20px;
			box-shadow: 0 2px 4px rgba(0,0,0,0.1);
		}
		.section h2 {
			color: #333;
			margin-bottom: 20px;
			padding-bottom: 10px;
			border-bottom: 2px solid #e5e7eb;
		}
		
		/* Tabs */
		.tabs {
			display: flex;
			gap: 5px;
			border-bottom: 2px solid #e5e7eb;
			margin-bottom: 20px;
		}
		.tab {
			padding: 12px 24px;
			background: #f3f4f6;
			border: none;
			border-radius: 6px 6px 0 0;
			cursor: pointer;
			font-size: 14px;
			font-weight: 600;
			color: #6b7280;
			transition: all 0.2s;
		}
		.tab:hover {
			background: #e5e7eb;
			color: #374151;
		}
		.tab.active {
			background: white;
			color: #667eea;
			border-bottom: 2px solid #667eea;
			margin-bottom: -2px;
		}
		.tab-content {
			display: none;
		}
		.tab-content.active {
			display: block;
		}
		
		table {
			width: 100%;
			border-collapse: collapse;
			margin-top: 15px;
		}
		th {
			background: #f9fafb;
			padding: 12px;
			text-align: left;
			font-weight: 600;
			color: #374151;
			border-bottom: 2px solid #e5e7eb;
		}
		td {
			padding: 12px;
			border-bottom: 1px solid #e5e7eb;
		}
		tr:hover { background: #f9fafb; }
		.badge {
			display: inline-block;
			padding: 4px 12px;
			border-radius: 12px;
			font-size: 12px;
			font-weight: 600;
		}
		.badge.success { background: #d1fae5; color: #065f46; }
		.badge.failure { background: #fee2e2; color: #991b1b; }
		.badge.skipped { background: #fef3c7; color: #92400e; }
		.badge.info { background: #dbeafe; color: #1e40af; }
		.badge.warning { background: #fef3c7; color: #92400e; }
		.badge.retry-pass { background: #fef9c3; color: #854d0e; border: 1px solid #fde047; }
		.badge.retry-fail { background: #fce7f3; color: #9d174d; border: 1px solid #f9a8d4; }
		.retry-pass-highlight { background: #fefce8 !important; }
		.retry-fail-highlight { background: #fdf2f8 !important; }
		.retry-attempt-box {
			border: 1px solid #e5e7eb;
			border-radius: 6px;
			margin: 8px 0;
			overflow: hidden;
		}
		.retry-attempt-header {
			padding: 6px 10px;
			font-size: 12px;
			font-weight: 600;
			border-bottom: 1px solid #e5e7eb;
		}
		.retry-attempt-header.attempt-fail { background: #fee2e2; color: #991b1b; }
		.retry-attempt-header.attempt-pass { background: #d1fae5; color: #065f46; }
		.retry-attempt-header.attempt-fail-retry { background: #fce7f3; color: #9d174d; }
		.retry-attempt-body { padding: 8px 10px; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
		.consumer-section { margin-bottom: 30px; }
		.consumer-header {
			background: #f3f4f6;
			padding: 15px;
			border-radius: 6px;
			margin-bottom: 15px;
		}
		.consumer-header h3 { color: #1f2937; margin-bottom: 8px; }
		.consumer-stats {
			display: flex;
			gap: 20px;
			margin-top: 10px;
			font-size: 14px;
			color: #6b7280;
		}
		.category-row {
			background: #fafafa;
			font-weight: 600;
		}
		.footer {
			text-align: center;
			color: #6b7280;
			margin-top: 30px;
			padding: 20px;
		}
		.failure-highlight {
			background: #fef2f2 !important;
		}
		.error-details {
			background: #fef2f2;
			border-left: 3px solid #ef4444;
			padding: 12px;
			margin: 8px 0;
			font-family: 'Courier New', monospace;
			font-size: 13px;
			white-space: pre-wrap;
			word-wrap: break-word;
			border-radius: 4px;
			max-height: 400px;
			overflow-y: auto;
		}
		.error-label {
			font-weight: 600;
			color: #991b1b;
			margin-bottom: 8px;
			display: block;
		}
		.output-text {
			color: #374151;
			line-height: 1.6;
			padding: 8px;
			background: #ffffff;
			border-radius: 4px;
			border: 1px solid #f3f4f6;
		}
		.comparison-container {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 12px;
			margin: 12px 0;
		}
		.expected-box, .actual-box {
			padding: 12px;
			border-radius: 6px;
			border: 2px solid;
		}
		.expected-box {
			background: #f0fdf4;
			border-color: #22c55e;
		}
		.actual-box {
			background: #fef2f2;
			border-color: #ef4444;
		}
		.box-label {
			font-weight: 700;
			font-size: 13px;
			margin-bottom: 8px;
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}
		.expected-box .box-label {
			color: #166534;
		}
		.actual-box .box-label {
			color: #991b1b;
		}
		.box-content {
			font-family: 'Courier New', monospace;
			font-size: 13px;
			color: #1f2937;
			white-space: pre-wrap;
			word-wrap: break-word;
			line-height: 1.5;
		}
		.log-section {
			margin-top: 12px;
			padding-top: 12px;
			border-top: 1px solid #e5e7eb;
		}
		.log-header {
			font-weight: 600;
			color: #374151;
			margin-bottom: 6px;
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.details-toggle {
			cursor: pointer;
			color: #3b82f6;
			text-decoration: underline;
			font-size: 12px;
		}
		.details-toggle:hover {
			color: #2563eb;
		}
		.details-content {
			display: none;
			margin-top: 8px;
		}
		.details-content.show {
			display: block;
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<h1>🧪 QVAC Batch Test Report</h1>
			<p>Run ID: ${data.runId}</p>
			<p>Generated: ${new Date().toLocaleString()}</p>
		</div>

		<div class="section" style="margin-bottom: 20px;">
			<h2>💻 System Information</h2>
			<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-top: 15px;">
				<div><strong>Hostname:</strong> ${systemInfo.hostname}</div>
				<div><strong>Platform:</strong> ${systemInfo.platform} ${systemInfo.arch}</div>
				<div><strong>OS Version:</strong> ${systemInfo.platformVersion}</div>
				<div><strong>CPU:</strong> ${systemInfo.cpus}</div>
				<div><strong>CPU Cores:</strong> ${systemInfo.cpuCores}</div>
				<div><strong>Total Memory:</strong> ${systemInfo.totalMemoryGB} GB</div>
				<div><strong>Free Memory:</strong> ${systemInfo.freeMemoryGB} GB (at report time)</div>
				<div><strong>Node Version:</strong> ${systemInfo.nodeVersion}</div>
			</div>
		</div>

		<div class="stats">
			<div class="stat-card info">
				<h3>Total Tests</h3>
				<div class="value">${data.completedTests.length}</div>
			</div>
			<div class="stat-card success">
				<h3>Passed</h3>
				<div class="value">${successCount}</div>
			</div>
			<div class="stat-card failure">
				<h3>Failed</h3>
				<div class="value">${failureCount}</div>
			</div>
			<div class="stat-card" style="border-left: 3px solid #f59e0b;">
				<h3>Skipped</h3>
				<div class="value" style="color: #f59e0b;">${skippedCount}</div>
			</div>
			${
        retriedCount > 0
          ? `
			<div class="stat-card" style="border-left: 3px solid #d97706; background: #fffbeb;">
				<h3>🔄 Retried</h3>
				<div class="value" style="color: #d97706;">${retriedCount}</div>
				<div style="font-size:11px; color:#92400e; margin-top:4px;">
					${retriedPassedCount > 0 ? `✓ ${retriedPassedCount} passed` : ''}
					${retriedPassedCount > 0 && retriedFailedCount > 0 ? ' · ' : ''}
					${retriedFailedCount > 0 ? `✗ ${retriedFailedCount} failed` : ''}
				</div>
			</div>`
          : ''
      }
			<div class="stat-card info">
				<h3>Success Rate</h3>
				<div class="value">${successRate}%</div>
			</div>
			<div class="stat-card info">
				<h3>Duration</h3>
				<div class="value">${elapsed.toFixed(0)}s</div>
			</div>
			<div class="stat-card info">
				<h3>Consumers</h3>
				<div class="value">${data.consumers.size}</div>
			</div>
		</div>

		<div class="section">
			<div class="tabs">
				<button class="tab active" onclick="switchTab('overview')">📊 Overview</button>
				${Array.from(testsByConsumer.keys())
          .map((consumerId, idx) => {
            const shortId = consumerId.split('-').slice(1, 3).join('-')
            return `<button class="tab" onclick="switchTab('consumer-${idx}')" title="${consumerId}">${shortId}</button>`
          })
          .join('')}
				<button class="tab" onclick="switchTab('all-tests')">📋 All Tests</button>
				${data.memorySummaries && data.memorySummaries.length > 0 ? '<button class="tab" onclick="switchTab(\'memory\')">📈 Memory</button>' : ''}
				${data.profilingData && data.profilingData.length > 0 ? '<button class="tab" onclick="switchTab(\'profiling\')">📈 Profiling</button>' : ''}
			</div>

			<!-- Overview Tab -->
			<div id="overview" class="tab-content active">
				<h2>📊 Results by Category</h2>
				<table>
					<thead>
						<tr>
							<th>Category</th>
							<th>Total</th>
							<th>Passed</th>
							<th>Skipped</th>
							<th>Failed</th>
							<th>Rate</th>
						</tr>
					</thead>
					<tbody>
						${Array.from(testsByCategory.entries())
              .map(([category, tests]) => {
                const passed = tests.filter((t) => t.outcome === 'success').length
                const failed = tests.filter((t) => t.outcome === 'failure').length
                const skipped = tests.filter((t) => t.outcome === 'skipped').length
                const nonSkippedTotal = tests.length - skipped
                const rate =
                  nonSkippedTotal > 0 ? ((passed / nonSkippedTotal) * 100).toFixed(0) : 'N/A'
                return `
							<tr>
								<td><strong>${category}</strong></td>
								<td>${tests.length}</td>
								<td>${passed}</td>
								<td>${skipped}</td>
								<td>${failed}</td>
								<td>${rate}${rate !== 'N/A' ? '%' : ''}</td>
							</tr>`
              })
              .join('')}
					</tbody>
				</table>

				${
          testsBySuite.size > 0
            ? `
				<h2 style="margin-top: 30px;">🏷️ Results by Suite</h2>
				<table>
					<thead>
						<tr>
							<th>Suite</th>
							<th>Total</th>
							<th>Passed</th>
							<th>Skipped</th>
							<th>Failed</th>
							<th>Rate</th>
						</tr>
					</thead>
					<tbody>
						${Array.from(testsBySuite.entries())
              .map(([suite, tests]) => {
                const passed = tests.filter((t) => t.outcome === 'success').length
                const failed = tests.filter((t) => t.outcome === 'failure').length
                const skipped = tests.filter((t) => t.outcome === 'skipped').length
                const nonSkippedTotal = tests.length - skipped
                const rate =
                  nonSkippedTotal > 0 ? ((passed / nonSkippedTotal) * 100).toFixed(0) : 'N/A'
                return `
							<tr>
								<td><strong>${suite}</strong></td>
								<td>${tests.length}</td>
								<td>${passed}</td>
								<td>${skipped}</td>
								<td>${failed}</td>
								<td>${rate}${rate !== 'N/A' ? '%' : ''}</td>
							</tr>`
              })
              .join('')}
					</tbody>
				</table>
				`
            : ''
        }

				${
          failureCount > 0
            ? `
				<h2 style="margin-top: 30px;">❌ Failed Tests Summary</h2>
				<table>
					<thead>
						<tr>
							<th>Test</th>
							<th>Consumer</th>
							<th>Duration</th>
							<th>Error Details</th>
						</tr>
					</thead>
					<tbody>
						${data.completedTests
              .filter((t) => t.outcome === 'failure')
              .map((test, idx) => {
                const detailsId = 'details-' + idx
                const retryBadge = renderRetryBadge(test)
                return `
						<tr class="${testRowClass(test)}">
							<td><strong>${escapeHtml(test.testId)}</strong>${retryBadge}</td>
							<td title="${escapeHtml(test.consumerId)}">${escapeHtml(test.consumerId.split('-').slice(1, 3).join('-'))}</td>
							<td>${(test.duration / 1000).toFixed(2)}s</td>
							<td>
								<span class="details-toggle" onclick="toggleDetails('${detailsId}')">📋 View Log</span>
								<div id="${detailsId}" class="details-content">
									${buildTestDetailsHtml(test, { includeConsumer: true })}
								</div>
							</td>
						</tr>
						`
              })
              .join('')}
					</tbody>
				</table>
				`
            : '<p style="margin-top: 20px; color: #10b981; font-weight: 600;">✅ All tests passed!</p>'
        }
			</div>

			<!-- Consumer Tabs -->
			${Array.from(testsByConsumer.entries())
        .map(([consumerId, tests], idx) => {
          const consumer = data.consumers.get(consumerId)
          const passed = tests.filter((t) => t.outcome === 'success').length
          const failed = tests.filter((t) => t.outcome === 'failure').length
          const avgDuration = tests.reduce((sum, t) => sum + t.duration, 0) / tests.length
          const shortId = consumerId.split('-').slice(1, 3).join('-')

          return `
				<div id="consumer-${idx}" class="tab-content">
					<div class="consumer-header">
						<h3>Consumer: ${shortId}</h3>
						<div style="font-size: 12px; color: #6b7280; margin-top: 4px; font-family: monospace;">Full ID: ${consumerId}</div>
						<div class="consumer-stats">
							<span>Platform: ${consumer?.platform || 'unknown'}</span>
							<span>Total Tests: ${tests.length}</span>
							<span>✅ Passed: ${passed}</span>
							<span>❌ Failed: ${failed}</span>
							<span>Success Rate: ${((passed / tests.length) * 100).toFixed(1)}%</span>
							<span>Avg Duration: ${(avgDuration / 1000).toFixed(1)}s</span>
						</div>
					</div>
					<table>
						<thead>
							<tr>
								<th>Test</th>
								<th>Status</th>
								<th>Duration</th>
								<th>Details</th>
							</tr>
						</thead>
						<tbody>
              ${tests
                .map((test, testIdx) => {
                  const detailsId = 'consumer-' + idx + '-test-' + testIdx
                  const retryBadge = renderRetryBadge(test)
                  const detailsCell =
                    test.outcome === 'failure'
                      ? '<span class="details-toggle" onclick="toggleDetails(\'' +
                        detailsId +
                        '\')">📋 View Log</span>' +
                        '<div id="' +
                        detailsId +
                        '" class="details-content">' +
                        buildTestDetailsHtml(test) +
                        '</div>'
                      : '✅'
                  return `
							<tr class="${testRowClass(test)}">
								<td>${escapeHtml(test.testId)}</td>
								<td><span class="badge ${test.outcome}">${test.outcome.toUpperCase()}</span>${retryBadge}</td>
								<td>${(test.duration / 1000).toFixed(2)}s</td>
								<td>${detailsCell}</td>
							</tr>
							`
                })
                .join('')}
						</tbody>
					</table>
				</div>
				`
        })
        .join('')}

			<!-- All Tests Tab -->
			<div id="all-tests" class="tab-content">
				<h2>📋 All Test Results</h2>
				<table>
					<thead>
						<tr>
							<th>Test</th>
							<th>Consumer</th>
							<th>Status</th>
							<th>Duration</th>
							<th>Details</th>
						</tr>
					</thead>
					<tbody>
						${data.completedTests
              .map((test, allIdx) => {
                const detailsId = 'all-test-' + allIdx
                const allRetryBadge = renderRetryBadge(test)
                const detailsCell =
                  test.outcome === 'failure'
                    ? '<span class="details-toggle" onclick="toggleDetails(\'' +
                      detailsId +
                      '\')">📋 View Log</span>' +
                      '<div id="' +
                      detailsId +
                      '" class="details-content">' +
                      buildTestDetailsHtml(test, { includeConsumer: true }) +
                      '</div>'
                    : '✅'
                return `
						<tr class="${testRowClass(test)}">
							<td>${escapeHtml(test.testId)}</td>
							<td title="${escapeHtml(test.consumerId)}">${escapeHtml(test.consumerId.split('-').slice(1, 3).join('-'))}</td>
							<td><span class="badge ${test.outcome}">${test.outcome.toUpperCase()}</span>${allRetryBadge}</td>
							<td>${(test.duration / 1000).toFixed(2)}s</td>
							<td>${detailsCell}</td>
						</tr>
						`
              })
              .join('')}
					</tbody>
				</table>
			</div>

			<!-- Memory Tab -->
			${data.memorySummaries && data.memorySummaries.length > 0 ? renderMemoryTab(data.memorySummaries, data.completedTests) : ''}

			<!-- Profiling Tab -->
			${
        data.profilingData && data.profilingData.length > 0
          ? `
			<div id="profiling" class="tab-content">
				<h2>📈 Performance Profiling</h2>
				<p style="color: #6b7280; margin-bottom: 20px;">Profiler metrics collected during test execution.</p>
				
				${data.profilingData
          .map((pd) => {
            const snapshotKind = pd.kind ?? 'final'
            const isIncomplete = pd.incomplete || snapshotKind !== 'final'
            const statusBadge = isIncomplete
              ? '<span class="badge warning">INCOMPLETE</span>'
              : '<span class="badge success">FINAL</span>'
            const snapshotTime = pd.timestamp ? new Date(pd.timestamp).toLocaleString() : undefined
            const receivedTime = pd.receivedAt
              ? new Date(pd.receivedAt).toLocaleString()
              : undefined
            const incompleteNotice = isIncomplete
              ? '<div style="background: #fffbeb; border: 1px solid #f59e0b; color: #92400e; padding: 12px; border-radius: 6px; margin-bottom: 15px;">Latest checkpoint only. This consumer did not publish a final profiling export, so the data may be stale or incomplete.</div>'
              : ''
            const parsed = parseProfilerExport(pd.profilerExport)
            if (!parsed) {
              return renderRawProfilerFallback(pd.consumerId, pd.profilerExport, incompleteNotice)
            }

            const shortId = pd.consumerId.split('-').slice(1, 3).join('-')
            const { config, aggregates, recentEvents } = parsed
            const metrics = Object.entries(aggregates).sort((a, b) => a[0].localeCompare(b[0]))

            const formatValue = (val: number, metricName: string) => {
              const lowerName = metricName.toLowerCase()
              if (lowerName.includes('bps') || lowerName.includes('speed')) {
                if (val < 1024) return val.toFixed(0) + ' B/s'
                if (val < 1024 * 1024) return (val / 1024).toFixed(1) + ' KB/s'
                return (val / (1024 * 1024)).toFixed(2) + ' MB/s'
              }
              if (
                lowerName.includes('bytes') ||
                lowerName.includes('downloaded') ||
                lowerName.includes('size')
              ) {
                if (val < 1024) return val.toFixed(0) + ' B'
                if (val < 1024 * 1024) return (val / 1024).toFixed(1) + ' KB'
                return (val / (1024 * 1024)).toFixed(2) + ' MB'
              }
              if (
                lowerName.includes('tokens') ||
                lowerName.includes('count') ||
                lowerName.includes('factor') ||
                lowerName.includes('segments') ||
                lowerName.includes('samples')
              ) {
                if (Number.isInteger(val)) return val.toLocaleString()
                if (Math.abs(val) < 0.01) return val.toExponential(2)
                if (Math.abs(val) < 1) return val.toFixed(3)
                if (Math.abs(val) < 100) return val.toFixed(2)
                return val.toFixed(1)
              }
              // Default: duration
              if (val < 1) return (val * 1000).toFixed(0) + 'μs'
              if (val < 1000) return val.toFixed(1) + 'ms'
              if (val < 60000) return (val / 1000).toFixed(2) + 's'
              return (val / 60000).toFixed(2) + 'm'
            }

            return `
				<div class="consumer-section">
					<div class="consumer-header">
						<h3>📊 ${shortId} ${statusBadge}</h3>
						<div class="consumer-stats">
							<span>Mode: ${config.mode ?? 'unknown'}</span>
							<span>Server Breakdown: ${config.includeServerBreakdown ? 'Yes' : 'No'}</span>
							<span>Metrics: ${metrics.length}</span>
							${recentEvents.length > 0 ? `<span>Events: ${recentEvents.length}</span>` : ''}
							<span>Snapshot: ${snapshotKind}</span>
							${pd.sequence !== undefined ? `<span>Sequence: ${pd.sequence}</span>` : ''}
							${snapshotTime ? `<span>Exported: ${snapshotTime}</span>` : ''}
							${receivedTime ? `<span>Received: ${receivedTime}</span>` : ''}
						</div>
					</div>
					${incompleteNotice}
					
					${
            metrics.length > 0
              ? (() => {
                  type MetricEntry = (typeof metrics)[number]
                  const groups: Record<string, MetricEntry[]> = {}
                  for (const entry of metrics) {
                    const prefix = entry[0].split('.')[0]
                    if (!groups[prefix]) groups[prefix] = []
                    groups[prefix].push(entry)
                  }
                  const groupNames = Object.keys(groups).sort()

                  return `
					<h4 style="margin: 15px 0 10px 0; color: #374151;">📊 Aggregate Metrics (${metrics.length})</h4>
					${groupNames
            .map((groupName) => {
              const groupMetrics = groups[groupName]
              return `
					<details style="margin-bottom: 10px; border: 1px solid #e5e7eb; border-radius: 6px;">
						<summary style="padding: 10px 15px; cursor: pointer; background: #f9fafb; border-radius: 6px; font-weight: 600; color: #374151;">
							${escapeHtml(groupName)} <span style="color: #6b7280; font-weight: normal;">(${groupMetrics.length} metrics)</span>
						</summary>
						<table style="margin: 0;">
							<thead>
								<tr>
									<th>Metric</th>
									<th>Count</th>
									<th>Min</th>
									<th>Max</th>
									<th>Avg</th>
									<th>Total</th>
								</tr>
							</thead>
							<tbody>
								${groupMetrics
                  .map(
                    ([name, stats]) => `
								<tr>
									<td><code>${escapeHtml(name)}</code></td>
									<td>${stats.count.toLocaleString()}</td>
									<td>${formatValue(stats.min, name)}</td>
									<td>${formatValue(stats.max, name)}</td>
									<td>${formatValue(stats.avg, name)}</td>
									<td>${formatValue(stats.sum, name)}</td>
								</tr>`
                  )
                  .join('')}
							</tbody>
						</table>
					</details>`
            })
            .join('')}`
                })()
              : '<p style="color: #6b7280;">No aggregate metrics recorded.</p>'
          }
					
					<!-- Recent Events Table (verbose mode) -->
					${
            recentEvents.length > 0
              ? `
					<h4 style="margin: 25px 0 10px 0; color: #374151;">📋 Recent Events (${recentEvents.length})</h4>
					<div style="max-height: 400px; overflow-y: auto;">
					<table>
						<thead>
							<tr>
								<th>Operation</th>
								<th>Kind</th>
								<th>Phase</th>
								<th>Duration</th>
								<th>Tags</th>
								<th>Gauges</th>
							</tr>
						</thead>
						<tbody>
							${recentEvents
                .slice(-100)
                .reverse()
                .map((event) => {
                  const tags = event.tags
                    ? Object.entries(event.tags)
                        .map(([k, v]) => escapeHtml(k) + '=' + escapeHtml(String(v)))
                        .join(', ')
                    : '-'
                  const gauges = event.gauges
                    ? Object.entries(event.gauges)
                        .map(([k, v]) => escapeHtml(k) + '=' + formatValue(v, k))
                        .join(', ')
                    : '-'
                  const duration = event.ms !== undefined ? formatValue(event.ms, 'duration') : '-'
                  return `
							<tr>
								<td><code>${escapeHtml(event.op ?? '')}</code></td>
								<td><span class="badge ${event.kind === 'handler' ? 'success' : event.kind === 'rpc' ? 'info' : ''}" style="font-size: 11px;">${escapeHtml(event.kind ?? '')}</span></td>
								<td>${escapeHtml(event.phase ?? '-')}</td>
								<td>${duration}</td>
								<td style="font-size: 12px; max-width: 200px; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(tags)}">${tags}</td>
								<td style="font-size: 12px; max-width: 200px; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(gauges)}">${gauges}</td>
							</tr>`
                })
                .join('')}
						</tbody>
					</table>
					</div>
					${recentEvents.length > 100 ? `<p style="color: #6b7280; font-size: 12px; margin-top: 10px;">Showing last 100 of ${recentEvents.length} events</p>` : ''}
					`
              : ''
          }
				</div>`
          })
          .join('')}
			</div>
			`
          : ''
      }
		</div>

		<div class="footer">
			<p>Generated by QVAC Batch Test Producer</p>
			<p>Total execution time: ${elapsed.toFixed(1)} seconds</p>
		</div>
	</div>

	<script>
		function switchTab(tabId) {
			// Hide all tab contents
			document.querySelectorAll('.tab-content').forEach(content => {
				content.classList.remove('active');
			});
			
			// Deactivate all tabs
			document.querySelectorAll('.tab').forEach(tab => {
				tab.classList.remove('active');
			});
			
			// Show selected tab content
			document.getElementById(tabId).classList.add('active');
			
			// Activate clicked tab
			event.target.classList.add('active');
		}
		
		function toggleDetails(detailsId) {
			const element = document.getElementById(detailsId);
			if (element) {
				element.classList.toggle('show');
			}
		}
	</script>
</body>
</html>`

  try {
    const absolutePath = path.resolve(filename)
    fs.writeFileSync(filename, html)
    return absolutePath
  } catch (error) {
    console.error(`\n❌ Failed to generate HTML report:`, error)
    throw error
  }
}

/**
 * Generate JSON report
 */
export function generateJsonReport(data: ReportData): string {
  const outDir = data.reportDir || 'reports'
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true })
  }

  // Generate filename
  let filename = path.join(outDir, `results-${data.runId}.json`)
  if (fs.existsSync(filename)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    filename = path.join(outDir, `results-${data.runId}-${timestamp}.json`)
  }

  const elapsed = data.startTime > 0 ? (Date.now() - data.startTime) / 1000 : 0
  const successCount = data.completedTests.filter((t) => t.outcome === 'success').length
  const failureCount = data.completedTests.filter((t) => t.outcome === 'failure').length
  const skippedCount = data.completedTests.filter((t) => t.outcome === 'skipped').length

  // Group by category — same metadata.category-first rule as the HTML side.
  const byCategory: Record<
    string,
    { passed: number; failed: number; skipped: number; total: number }
  > = {}
  for (const test of data.completedTests) {
    const category =
      test.category ?? (test.testId.includes('-') ? test.testId.split('-')[0] : test.testId)
    if (!byCategory[category]) {
      byCategory[category] = { passed: 0, failed: 0, skipped: 0, total: 0 }
    }
    byCategory[category].total++
    if (test.outcome === 'success') {
      byCategory[category].passed++
    } else if (test.outcome === 'skipped') {
      byCategory[category].skipped++
    } else {
      byCategory[category].failed++
    }
  }

  // Group by suite for JSON
  const bySuite: Record<
    string,
    { passed: number; failed: number; skipped: number; total: number }
  > = {}
  for (const test of data.completedTests) {
    if (!test.suites) continue
    for (const suite of test.suites) {
      if (!bySuite[suite]) {
        bySuite[suite] = { passed: 0, failed: 0, skipped: 0, total: 0 }
      }
      bySuite[suite].total++
      if (test.outcome === 'success') bySuite[suite].passed++
      else if (test.outcome === 'skipped') bySuite[suite].skipped++
      else bySuite[suite].failed++
    }
  }

  const nonSkipped = data.completedTests.length - skippedCount
  const jsonReport = {
    runId: data.runId,
    timestamp: new Date().toISOString(),
    summary: {
      total: data.completedTests.length,
      passed: successCount,
      failed: failureCount,
      skipped: skippedCount,
      successRate: nonSkipped > 0 ? ((successCount / nonSkipped) * 100).toFixed(1) : '0.0',
      duration: elapsed
    },
    categories: byCategory,
    suites: Object.keys(bySuite).length > 0 ? bySuite : undefined,
    tests: data.completedTests.map((test) => ({
      testId: test.testId,
      consumerId: test.consumerId,
      outcome: test.outcome,
      duration: test.duration,
      error: test.error,
      output: test.output,
      suites: test.suites,
      ...(test.retried && {
        retried: true,
        retryPassed: test.retryPassed,
        retryOutput: test.retryOutput
      })
    })),
    consumers: Array.from(data.consumers.values()),
    system: systemInfo,
    profiling: data.profilingData?.map((pd) => ({
      consumerId: pd.consumerId,
      ...pd.profilerExport,
      snapshotKind: pd.kind ?? 'final',
      snapshotSequence: pd.sequence,
      snapshotTimestamp: pd.timestamp,
      snapshotReceivedAt: pd.receivedAt ? new Date(pd.receivedAt).toISOString() : undefined,
      incomplete: pd.incomplete || (pd.kind ?? 'final') !== 'final'
    })),
    memory: data.memorySummaries
  }

  try {
    const absolutePath = path.resolve(filename)
    fs.writeFileSync(filename, JSON.stringify(jsonReport, null, 2))
    return absolutePath
  } catch (error) {
    console.error(`\n❌ Failed to generate JSON report:`, error)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Memory tab rendering
// ---------------------------------------------------------------------------

function formatKb(kb: number): string {
  if (kb < 1024) return `${kb} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

function metricLabel(metric: string): string {
  switch (metric) {
    case 'VmRSS':
    case 'status.VmRSS':
      return 'RSS (VmRSS)'
    case 'physFootprint':
    case 'task_vm_info.physFootprint':
      return 'Phys footprint'
    case 'rss':
      return 'RSS'
    case 'task_vm_info.resident_size':
      return 'RSS (task_vm_info)'
    case 'smaps_rollup.pss':
      return 'PSS (smaps_rollup)'
    case 'smaps_rollup.uss':
      return 'USS (smaps_rollup)'
    case 'task_vm_info.region_count':
      return 'VM regions'
    case 'maps.count':
      return 'mmap regions'
    default:
      return metric
  }
}

function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** Format a raw series value according to its unit. */
function formatValue(value: number, unit: MemoryUnit): string {
  return unit === 'count' ? formatCount(value) : formatKb(value)
}

/** DOM-safe identifier fragment derived from a metric label. */
function metricSlug(metric: string): string {
  return metric.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'series'
}

/**
 * Render the Memory tab. Each metric series gets its own stat cards, chart and
 * per-test delta table, stacked vertically. A jump-nav appears when more than
 * one series is present.
 */
function renderMemoryTab(summaries: MemorySummary[], completedTests: ReportTestResult[]): string {
  // Index test results by uniqueTestId so each per-test memory row can be
  // tagged with the test's outcome (success / failure / skipped). Falls back
  // to keying by testId+consumerId for backwards compat with older runs that
  // didn't include uniqueTestId in the test-result payload. Shared across all
  // series.
  const outcomeByUid = new Map<string, ReportTestResult['outcome']>()
  const outcomeByTestKey = new Map<string, ReportTestResult['outcome']>()
  const retryOutcomeByUid = new Map<string, ReportTestResult['outcome']>()
  for (const t of completedTests) {
    if (t.uniqueTestId) outcomeByUid.set(t.uniqueTestId, t.outcome)
    outcomeByTestKey.set(`${t.testId}|${t.consumerId}`, t.outcome)
    if (t.retried && t.uniqueTestId) {
      retryOutcomeByUid.set(t.uniqueTestId, t.retryPassed ? 'success' : 'failure')
    }
  }
  const outcomeFor = (uniqueTestId: string, testId: string, consumerId: string) =>
    outcomeByUid.get(uniqueTestId) ?? outcomeByTestKey.get(`${testId}|${consumerId}`) ?? 'success'

  const jumpNav =
    summaries.length > 1
      ? `<div style="margin-bottom:20px;font-size:13px;color:#6b7280;">Series:&nbsp;${summaries
          .map(
            (s) =>
              `<a href="#mem-${escapeHtml(metricSlug(s.metric))}" style="margin-right:12px;">${escapeHtml(metricLabel(s.metric))}</a>`
          )
          .join('')}</div>`
      : ''

  const sections = summaries
    .map((s, i) => renderMemorySeries(s, i, outcomeFor, retryOutcomeByUid))
    .join('\n')

  return `
		<div id="memory" class="tab-content">
			<h2>📈 Memory</h2>
			<p style="color:#6b7280;margin-bottom:12px;">
				${summaries.length} metric series captured on <code>${escapeHtml(summaries[0].platform)}</code>.
				Each series has its own chart and per-test delta table. Click any column header to resort.
			</p>
			${jumpNav}
			${sections}
			<script>
				function sortMemTable(th, defaultDir) {
					var table = th.closest('table');
					if (!table) return;
					var headerRow = th.parentNode;
					var headers = Array.prototype.slice.call(headerRow.children);
					var idx = headers.indexOf(th);
					// Toggle direction if same column already active.
					var dir = th.classList.contains('active')
						? th.getAttribute('data-dir') === 'asc' ? 'desc' : 'asc'
						: (defaultDir || 'asc');
					headers.forEach(function (h) {
						h.classList.remove('active');
						h.removeAttribute('data-dir');
					});
					th.classList.add('active');
					th.setAttribute('data-dir', dir);
					var tbody = table.tBodies[0];
					var rows = Array.prototype.slice.call(tbody.rows);
					rows.sort(function (a, b) {
						var av = a.cells[idx].getAttribute('data-sort') || '';
						var bv = b.cells[idx].getAttribute('data-sort') || '';
						var an = av === '' ? NaN : parseFloat(av);
						var bn = bv === '' ? NaN : parseFloat(bv);
						// Missing values always sort to the bottom, regardless of direction.
						if (isNaN(an) && isNaN(bn)) return av.localeCompare(bv);
						if (isNaN(an)) return 1;
						if (isNaN(bn)) return -1;
						// Both parsed as finite numbers -> numeric compare. parseFloat
						// returning a finite number also implies the string starts with a
						// digit, so this won't false-match alpha values like "abc".
						var cmp = isFinite(an) && isFinite(bn) ? an - bn : av.localeCompare(bv);
						return dir === 'asc' ? cmp : -cmp;
					});
					rows.forEach(function (r) { tbody.appendChild(r); });
				}
			</script>
		</div>`
}

/** Render one metric series block (stat cards + chart + per-test table). */
function renderMemorySeries(
  summary: MemorySummary,
  index: number,
  outcomeFor: (
    uniqueTestId: string,
    testId: string,
    consumerId: string
  ) => ReportTestResult['outcome'],
  retryOutcomeByUid: Map<string, ReportTestResult['outcome']>
): string {
  const unit = summary.unit
  const slug = metricSlug(summary.metric)
  const peakStr = formatValue(summary.peakSuite.memoryKb, unit)
  const growthStr = formatValue(Math.abs(summary.growthKb), unit)
  const growthSign = summary.growthKb >= 0 ? '+' : '-'
  const limitFrac =
    summary.limitKb && summary.limitKb > 0
      ? `${((summary.peakSuite.memoryKb / summary.limitKb) * 100).toFixed(1)}%`
      : null
  const limitLabel = unit === 'count' ? 'Ceiling' : 'Memory limit'
  const tableId = `memory-per-test-table-${index}`

  // Render rows; sorted by peak desc by default. Client-side JS in the
  // page resorts on header click without re-rendering the data.
  let perTestSkippedCount = 0
  let perTestFailedCount = 0
  let perTestPassedCount = 0
  let perTestIncompleteCount = 0
  const rows = summary.perTest
    .map((t) => {
      const consumerShort = t.consumerId.split('-').slice(1, 3).join('-')
      const startedSec = ((t.startTs - summary.startTs) / 1000).toFixed(1)
      // Incomplete = orphan start (no result MQTT received -- consumer
      // crashed mid-test, e.g. OOM kill). Show as a distinct outcome so
      // the table doesn't silently drop the test the user most cares
      // about (often the one responsible for the suite peak).
      const baseOutcome = outcomeFor(t.uniqueTestId, t.testId, t.consumerId)
      // Retried tests are split into two rows: attempt 1 always failed (it
      // triggered the reload), attempt 2 carries the final retry outcome.
      const rowOutcome =
        t.attemptLabel === '1'
          ? 'failure'
          : t.attemptLabel === '2'
            ? (retryOutcomeByUid.get(t.uniqueTestId) ?? baseOutcome)
            : baseOutcome
      const outcome: 'success' | 'failure' | 'skipped' | 'crashed' = t.incomplete
        ? 'crashed'
        : rowOutcome
      // Don't double-count attempt-1 rows in the summary counts.
      if (t.attemptLabel !== '1') {
        if (outcome === 'skipped') perTestSkippedCount++
        else if (outcome === 'failure') perTestFailedCount++
        else if (outcome === 'crashed') perTestIncompleteCount++
        else perTestPassedCount++
      }

      const fmtBefore = t.beforeKb !== null ? formatValue(t.beforeKb, unit) : '—'
      const fmtAfter = t.afterKb !== null ? formatValue(t.afterKb, unit) : '—'
      const fmtPeak = t.peakKb > 0 ? formatValue(t.peakKb, unit) : '—'
      const fmtMean = t.meanKb > 0 ? formatValue(t.meanKb, unit) : '—'
      const fmtDelta =
        t.deltaKb === null
          ? '—'
          : `${t.deltaKb >= 0 ? '+' : '-'}${formatValue(Math.abs(t.deltaKb), unit)}`
      const deltaColor =
        t.deltaKb === null ? '' : `color:${t.deltaKb >= 0 ? '#ef4444' : '#10b981'};`
      const isAttempt1 = t.attemptLabel === '1'
      const isAttempt2 = t.attemptLabel === '2'
      let rowStyle = ''
      if (outcome === 'skipped') {
        rowStyle = ' style="opacity:0.55;"'
      } else if (outcome === 'crashed') {
        rowStyle = ' style="background:#fef2f2;"'
      } else if (isAttempt1 || isAttempt2) {
        rowStyle = ' style="border-left:3px solid #f59e0b;"'
      }

      const attemptCell = isAttempt1
        ? `<code>${escapeHtml(t.testId)}</code><br><span style="font-size:11px;color:#92400e;font-weight:600;">attempt 1</span>`
        : isAttempt2
          ? `<code>${escapeHtml(t.testId)}</code><br><span style="font-size:11px;color:#92400e;font-weight:600;">attempt 2 (after reload)</span>`
          : `<code>${escapeHtml(t.testId)}</code>`

      // data-* attributes carry sortable raw numbers so client-side sort
      // can avoid re-parsing the formatted values.
      return `
					<tr${rowStyle}>
						<td data-sort="${escapeHtml(t.testId)}">${attemptCell}</td>
						<td data-sort="${escapeHtml(outcome)}"><span class="badge ${outcome === 'crashed' ? 'failure' : escapeHtml(outcome)}">${escapeHtml(outcome.toUpperCase())}</span></td>
						<td data-sort="${escapeHtml(t.consumerId)}" title="${escapeHtml(t.consumerId)}">${escapeHtml(consumerShort)}</td>
						<td data-sort="${t.startTs}">+${startedSec}s</td>
						<td data-sort="${t.beforeKb ?? ''}">${fmtBefore}</td>
						<td data-sort="${t.peakKb}">${fmtPeak}</td>
						<td data-sort="${t.afterKb ?? ''}">${fmtAfter}</td>
						<td data-sort="${t.deltaKb ?? ''}" style="${deltaColor}">${fmtDelta}</td>
						<td data-sort="${t.meanKb}">${fmtMean}</td>
						<td data-sort="${t.durationMs}">${(t.durationMs / 1000).toFixed(1)}s</td>
						<td data-sort="${t.samples}">${t.samples}</td>
					</tr>`
    })
    .join('')

  return `
			<section id="mem-${escapeHtml(slug)}" style="margin-bottom:40px;${index > 0 ? 'border-top:1px solid #e5e7eb;padding-top:24px;' : ''}">
			<h3 style="margin:0 0 4px 0;color:#111827;">${escapeHtml(metricLabel(summary.metric))}</h3>
			<p style="color:#6b7280;font-size:13px;margin:0 0 16px 0;">
				metric <code>${escapeHtml(summary.metric)}</code> · unit <code>${escapeHtml(unit)}</code>
			</p>

			<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:15px;margin-bottom:20px;">
				<div class="stat-card info">
					<h3>Suite peak</h3>
					<div class="value">${peakStr}</div>
					${summary.peakSuite.activeTestId ? `<div style="font-size:12px;color:#6b7280;margin-top:5px;">during <code>${escapeHtml(summary.peakSuite.activeTestId)}</code></div>` : ''}
				</div>
				<div class="stat-card info">
					<h3>Net Δ across run</h3>
					<div class="value" style="color:${summary.growthKb >= 0 ? '#ef4444' : '#10b981'};">${growthSign}${growthStr}</div>
					<div style="font-size:12px;color:#6b7280;margin-top:5px;">last sample minus first</div>
				</div>
				${
          summary.limitKb
            ? `<div class="stat-card info">
					<h3>${limitLabel}</h3>
					<div class="value">${formatValue(summary.limitKb, unit)}</div>
					${limitFrac ? `<div style="font-size:12px;color:#6b7280;margin-top:5px;">peak: ${limitFrac} of limit</div>` : ''}
				</div>`
            : ''
        }
				<div class="stat-card info">
					<h3>Duration</h3>
					<div class="value">${(summary.durationMs / 1000).toFixed(0)}s</div>
				</div>
			</div>

			<h4 style="margin:20px 0 10px 0;color:#374151;">Over time</h4>
			${renderMemoryChart(summary)}

			<h4 style="margin:30px 0 10px 0;color:#374151;">Per-test delta</h4>
			<p style="color:#6b7280;font-size:13px;margin-bottom:10px;">
				<strong>Before</strong> = first sample while the test ran.
				<strong>After</strong> = last sample while the test ran.
				<strong>Δ</strong> = After − Before, the test's net effect on this metric across its observable
				window. Click any column header to sort.
				Retried tests are split into two rows (marked
				<span style="font-size:11px;color:#92400e;font-weight:600;">attempt 1</span> /
				<span style="font-size:11px;color:#92400e;font-weight:600;">attempt 2 (after reload)</span>)
				with a <span style="display:inline-block;width:8px;height:12px;background:#f59e0b;vertical-align:middle;border-radius:1px;"></span>
				amber border — each row covers only its own phase, making it easy to spot which attempt caused a memory spike or crash.
			</p>
			${
        perTestSkippedCount + perTestFailedCount + perTestPassedCount + perTestIncompleteCount > 0
          ? `<div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
				<span style="color:#10b981;">${perTestPassedCount} passed</span>
				${perTestFailedCount > 0 ? `&nbsp;·&nbsp;<span style="color:#ef4444;">${perTestFailedCount} failed</span>` : ''}
				${perTestIncompleteCount > 0 ? `&nbsp;·&nbsp;<span style="color:#991b1b;font-weight:600;">${perTestIncompleteCount} crashed</span> (no result returned; row uses last sample before crash as end)` : ''}
				${perTestSkippedCount > 0 ? `&nbsp;·&nbsp;<span style="color:#92400e;">${perTestSkippedCount} skipped</span> (faded rows; window not representative)` : ''}
			</div>`
          : ''
      }
			<table id="${tableId}">
				<thead>
					<tr>
						<th onclick="sortMemTable(this,'asc')" style="cursor:pointer;" title="Sort">Test ▾</th>
						<th onclick="sortMemTable(this,'asc')" style="cursor:pointer;" title="Sort by outcome">Outcome ▾</th>
						<th onclick="sortMemTable(this,'asc')" style="cursor:pointer;" title="Sort">Consumer ▾</th>
						<th onclick="sortMemTable(this,'asc')" style="cursor:pointer;" title="Sort chronologically">Started ▾</th>
						<th onclick="sortMemTable(this,'desc')" style="cursor:pointer;" title="Sort">Before ▾</th>
						<th onclick="sortMemTable(this,'desc')" class="active" style="cursor:pointer;" title="Sort">Peak ▾</th>
						<th onclick="sortMemTable(this,'desc')" style="cursor:pointer;" title="Sort">After ▾</th>
						<th onclick="sortMemTable(this,'desc')" style="cursor:pointer;" title="Sort by net change">Δ ▾</th>
						<th onclick="sortMemTable(this,'desc')" style="cursor:pointer;" title="Sort">Mean ▾</th>
						<th onclick="sortMemTable(this,'desc')" style="cursor:pointer;" title="Sort">Duration ▾</th>
						<th onclick="sortMemTable(this,'desc')" style="cursor:pointer;" title="Sort">Samples ▾</th>
					</tr>
				</thead>
				<tbody>${rows}
				</tbody>
			</table>
			</section>`
}

function renderMemoryChart(summary: MemorySummary): string {
  const points = summary.chart
  const unit = summary.unit
  if (points.length < 2) {
    return '<p style="color:#6b7280;">Not enough samples to draw chart.</p>'
  }

  const W = 1000
  const H = 320
  const padL = 60
  const padR = 20
  const padT = 20
  const padB = 40
  const innerW = W - padL - padR
  const innerH = H - padT - padB

  const t0 = points[0].ts
  const t1 = points[points.length - 1].ts
  const tSpan = Math.max(1, t1 - t0)

  let yMax = 0
  for (const p of points) {
    if (p.memoryKb > yMax) yMax = p.memoryKb
    if (p.max60sKb > yMax) yMax = p.max60sKb
  }
  if (summary.limitKb && summary.limitKb > yMax) yMax = summary.limitKb
  if (yMax === 0) yMax = 1
  // Round up to a nice value: next 50 MB for memory sizes, next power-of-ten
  // step for counts so the mmap-region axis isn't squashed.
  const yMaxRounded =
    unit === 'count' ? niceCeil(yMax) : Math.ceil(yMax / (50 * 1024)) * (50 * 1024)

  const x = (ts: number) => padL + ((ts - t0) / tSpan) * innerW
  const y = (kb: number) => padT + innerH - (kb / yMaxRounded) * innerH

  // Downsample to keep SVG manageable for very long runs (>3000 points).
  let series = points
  if (points.length > 3000) {
    const stride = Math.ceil(points.length / 3000)
    series = points.filter((_, i) => i % stride === 0)
    if (series[series.length - 1] !== points[points.length - 1]) {
      series.push(points[points.length - 1])
    }
  }

  const lineCur = series
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.memoryKb).toFixed(1)}`)
    .join(' ')
  const line60s = series
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.max60sKb).toFixed(1)}`)
    .join(' ')

  // Y-axis grid lines + labels at 0, 25, 50, 75, 100%.
  const gridLines = [0, 0.25, 0.5, 0.75, 1.0]
    .map((frac) => {
      const yPos = padT + innerH - frac * innerH
      const label = formatValue(yMaxRounded * frac, unit)
      return (
        `<line x1="${padL}" x2="${W - padR}" y1="${yPos}" y2="${yPos}" stroke="#e5e7eb" stroke-width="1"/>` +
        `<text x="${padL - 6}" y="${yPos + 4}" text-anchor="end" font-size="11" fill="#6b7280">${label}</text>`
      )
    })
    .join('')

  // X-axis labels (start, mid, end) as elapsed seconds from t0.
  const xLabels = [0, 0.5, 1.0]
    .map((frac) => {
      const xPos = padL + frac * innerW
      const elapsedSec = ((tSpan * frac) / 1000).toFixed(0)
      return `<text x="${xPos}" y="${H - 12}" text-anchor="middle" font-size="11" fill="#6b7280">${elapsedSec}s</text>`
    })
    .join('')

  // Limit/ceiling line if present.
  const limitLine = summary.limitKb
    ? `<line x1="${padL}" x2="${W - padR}" y1="${y(summary.limitKb)}" y2="${y(summary.limitKb)}" stroke="#ef4444" stroke-dasharray="4 3" stroke-width="1"/>` +
      `<text x="${W - padR - 4}" y="${y(summary.limitKb) - 4}" text-anchor="end" font-size="11" fill="#ef4444">limit: ${formatValue(summary.limitKb, unit)}</text>`
    : ''

  // Peak marker.
  const peak = summary.peakSuite
  const peakX = x(peak.ts)
  const peakY = y(peak.memoryKb)
  const peakMarker =
    `<circle cx="${peakX}" cy="${peakY}" r="4" fill="#ef4444"/>` +
    `<text x="${peakX}" y="${peakY - 8}" text-anchor="middle" font-size="11" fill="#ef4444">peak: ${formatValue(peak.memoryKb, unit)}</text>`

  return `
		<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;background:#fafafa;border-radius:6px;">
			${gridLines}
			${limitLine}
			<path d="${line60s}" fill="none" stroke="#a78bfa" stroke-width="1" opacity="0.7"/>
			<path d="${lineCur}" fill="none" stroke="#3b82f6" stroke-width="1.4"/>
			${peakMarker}
			${xLabels}
			<text x="${W - padR}" y="${padT + 12}" text-anchor="end" font-size="11" fill="#6b7280">
				<tspan fill="#3b82f6">— ${escapeHtml(metricLabel(summary.metric))}</tspan>
				<tspan dx="10" fill="#a78bfa">— max(60s)</tspan>
			</text>
		</svg>`
}

/** Round up to a visually pleasant axis maximum (1/2/5 × 10ⁿ) for counts. */
function niceCeil(value: number): number {
  if (value <= 0) return 1
  const exp = Math.floor(Math.log10(value))
  const base = Math.pow(10, exp)
  const frac = value / base
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10
  return niceFrac * base
}
