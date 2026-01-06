import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ReportTestResult {
  testId: string;
  consumerId: string;
  outcome: 'success' | 'failure';
  duration: number;
  error?: string;
  output?: string;
  expected?: string;
  actual?: string;
}

export interface ReportConsumerInfo {
  consumerId: string;
  platform: string;
}

export interface ReportData {
  runId: string;
  completedTests: ReportTestResult[];
  consumers: Map<string, ReportConsumerInfo>;
  startTime: number;
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
  nodeVersion: process.version,
};

export function generateHtmlReport(data: ReportData): string {
  // Create reports directory if it doesn't exist
  if (!fs.existsSync('reports')) {
    fs.mkdirSync('reports');
  }

  // Try filename with run ID first
  let filename = `reports/batch-report-${data.runId}.html`;

  // If file exists, add timestamp to make it unique
  if (fs.existsSync(filename)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    filename = `reports/batch-report-${data.runId}-${timestamp}.html`;
  }

  const elapsed = (Date.now() - data.startTime) / 1000;
  const successCount = data.completedTests.filter((t) => t.outcome === 'success').length;
  const failureCount = data.completedTests.filter((t) => t.outcome === 'failure').length;
  const successRate =
    data.completedTests.length > 0 ? ((successCount / data.completedTests.length) * 100).toFixed(1) : '0.0';

  // Group tests by consumer
  const testsByConsumer = new Map<string, ReportTestResult[]>();
  for (const test of data.completedTests) {
    if (!testsByConsumer.has(test.consumerId)) {
      testsByConsumer.set(test.consumerId, []);
    }
    testsByConsumer.get(test.consumerId)!.push(test);
  }

  // Group tests by category
  const testsByCategory = new Map<string, ReportTestResult[]>();
  for (const test of data.completedTests) {
    const category = test.testId.split('-')[0];
    if (!testsByCategory.has(category)) {
      testsByCategory.set(category, []);
    }
    testsByCategory.get(category)!.push(test);
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
			grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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
            const shortId = consumerId.split('-').slice(1, 3).join('-');
            return `<button class="tab" onclick="switchTab('consumer-${idx}')" title="${consumerId}">${shortId}</button>`;
          })
          .join('')}
				<button class="tab" onclick="switchTab('all-tests')">📋 All Tests</button>
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
							<th>Failed</th>
							<th>Rate</th>
						</tr>
					</thead>
					<tbody>
						${Array.from(testsByCategory.entries())
              .map(([category, tests]) => {
                const passed = tests.filter((t) => t.outcome === 'success').length;
                const failed = tests.filter((t) => t.outcome === 'failure').length;
                const rate = ((passed / tests.length) * 100).toFixed(0);
                return `
							<tr>
								<td><strong>${category}</strong></td>
								<td>${tests.length}</td>
								<td>${passed}</td>
								<td>${failed}</td>
								<td>${rate}%</td>
							</tr>`;
              })
              .join('')}
					</tbody>
				</table>

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
                const errorMsg = test.error || 'No error message';
                const outputMsg = test.output || 'No output';
                const detailsId = 'details-' + idx;
                const escapedError = errorMsg.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const escapedOutput = outputMsg.replace(/</g, '&lt;').replace(/>/g, '&gt;');

                // Build comprehensive error details with Expected vs Actual comparison
                let errorDetailsHtml = '<div class="error-details">';
                errorDetailsHtml += '<div class="error-label">❌ Failure Analysis</div>';

                // Show Expected vs Actual if available
                if (test.expected && test.actual) {
                  const escapedExpected = test.expected.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  const escapedActual = test.actual.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  errorDetailsHtml += '<div class="comparison-container">';
                  errorDetailsHtml += '<div class="expected-box">';
                  errorDetailsHtml += '<div class="box-label">✅ Expected</div>';
                  errorDetailsHtml += '<div class="box-content">' + escapedExpected + '</div>';
                  errorDetailsHtml += '</div>';
                  errorDetailsHtml += '<div class="actual-box">';
                  errorDetailsHtml += '<div class="box-label">❌ Actual</div>';
                  errorDetailsHtml += '<div class="box-content">' + escapedActual + '</div>';
                  errorDetailsHtml += '</div>';
                  errorDetailsHtml += '</div>';
                }

                // Show error message
                errorDetailsHtml += '<div class="log-section">';
                errorDetailsHtml += '<div class="log-header">📋 Error Message</div>';
                errorDetailsHtml += '<div class="output-text">' + escapedError + '</div>';
                errorDetailsHtml += '</div>';

                // Show output if different from error
                if (outputMsg !== errorMsg && outputMsg !== 'No output') {
                  errorDetailsHtml += '<div class="log-section">';
                  errorDetailsHtml += '<div class="log-header">📄 Test Output / Log</div>';
                  errorDetailsHtml += '<div class="output-text">' + escapedOutput + '</div>';
                  errorDetailsHtml += '</div>';
                }

                // Show test information
                errorDetailsHtml += '<div class="log-section">';
                errorDetailsHtml += '<div class="log-header">ℹ️  Test Information</div>';
                errorDetailsHtml += '<div class="output-text">';
                errorDetailsHtml += '<strong>Test ID:</strong> ' + test.testId + '<br>';
                errorDetailsHtml += '<strong>Consumer:</strong> ' + test.consumerId + '<br>';
                errorDetailsHtml += '<strong>Duration:</strong> ' + (test.duration / 1000).toFixed(2) + 's<br>';
                errorDetailsHtml += '<strong>Timestamp:</strong> ' + new Date().toISOString();
                errorDetailsHtml += '</div></div>';
                errorDetailsHtml += '</div>';

                return `
						<tr class="failure-highlight">
							<td><strong>${test.testId}</strong></td>
							<td title="${test.consumerId}">${test.consumerId.split('-').slice(1, 3).join('-')}</td>
							<td>${(test.duration / 1000).toFixed(2)}s</td>
							<td>
								<span class="details-toggle" onclick="toggleDetails('${detailsId}')">📋 View Complete Log</span>
								<div id="${detailsId}" class="details-content">
									${errorDetailsHtml}
								</div>
							</td>
						</tr>
						`;
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
          const consumer = data.consumers.get(consumerId);
          const passed = tests.filter((t) => t.outcome === 'success').length;
          const failed = tests.filter((t) => t.outcome === 'failure').length;
          const avgDuration = tests.reduce((sum, t) => sum + t.duration, 0) / tests.length;
          const shortId = consumerId.split('-').slice(1, 3).join('-');

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
                  const detailsId = 'consumer-' + idx + '-test-' + testIdx;
                  const errorMsg = test.error || 'No error message';
                  const outputMsg = test.output || 'No output';
                  const escapedError = errorMsg.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  const escapedOutput = outputMsg.replace(/</g, '&lt;').replace(/>/g, '&gt;');

                  // Build comprehensive error details with Expected vs Actual
                  let errorDetailsHtml = '<div class="error-details">';
                  errorDetailsHtml += '<div class="error-label">❌ Failure Analysis</div>';

                  // Show Expected vs Actual if available
                  if (test.expected && test.actual) {
                    const escapedExpected = test.expected.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const escapedActual = test.actual.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    errorDetailsHtml += '<div class="comparison-container">';
                    errorDetailsHtml += '<div class="expected-box">';
                    errorDetailsHtml += '<div class="box-label">✅ Expected</div>';
                    errorDetailsHtml += '<div class="box-content">' + escapedExpected + '</div>';
                    errorDetailsHtml += '</div>';
                    errorDetailsHtml += '<div class="actual-box">';
                    errorDetailsHtml += '<div class="box-label">❌ Actual</div>';
                    errorDetailsHtml += '<div class="box-content">' + escapedActual + '</div>';
                    errorDetailsHtml += '</div>';
                    errorDetailsHtml += '</div>';
                  }

                  // Show error message
                  errorDetailsHtml += '<div class="log-section"><div class="log-header">📋 Error Message</div>';
                  errorDetailsHtml += '<div class="output-text">' + escapedError + '</div></div>';

                  // Show output if different
                  if (outputMsg !== errorMsg && outputMsg !== 'No output') {
                    errorDetailsHtml += '<div class="log-section"><div class="log-header">📄 Test Output / Log</div>';
                    errorDetailsHtml += '<div class="output-text">' + escapedOutput + '</div></div>';
                  }

                  errorDetailsHtml += '<div class="log-section"><div class="log-header">ℹ️  Test Information</div>';
                  errorDetailsHtml +=
                    '<div class="output-text"><strong>Duration:</strong> ' +
                    (test.duration / 1000).toFixed(2) +
                    's</div></div>';
                  errorDetailsHtml += '</div>';

                  const detailsCell =
                    test.outcome === 'failure'
                      ? '<span class="details-toggle" onclick="toggleDetails(\'' +
                        detailsId +
                        '\')">📋 View Complete Log</span>' +
                        '<div id="' +
                        detailsId +
                        '" class="details-content">' +
                        errorDetailsHtml +
                        '</div>'
                      : '✅';
                  return `
							<tr class="${test.outcome === 'failure' ? 'failure-highlight' : ''}">
								<td>${test.testId}</td>
								<td><span class="badge ${test.outcome}">${test.outcome.toUpperCase()}</span></td>
								<td>${(test.duration / 1000).toFixed(2)}s</td>
								<td>${detailsCell}</td>
							</tr>
							`;
                })
                .join('')}
						</tbody>
					</table>
				</div>
				`;
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
                const detailsId = 'all-test-' + allIdx;
                const errorMsg = test.error || 'No error message';
                const outputMsg = test.output || 'No output';
                const escapedError = errorMsg.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const escapedOutput = outputMsg.replace(/</g, '&lt;').replace(/>/g, '&gt;');

                // Build comprehensive error details with Expected vs Actual
                let errorDetailsHtml = '<div class="error-details">';
                errorDetailsHtml += '<div class="error-label">❌ Failure Analysis</div>';

                // Show Expected vs Actual if available
                if (test.expected && test.actual) {
                  const escapedExpected = test.expected.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  const escapedActual = test.actual.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  errorDetailsHtml += '<div class="comparison-container">';
                  errorDetailsHtml += '<div class="expected-box">';
                  errorDetailsHtml += '<div class="box-label">✅ Expected</div>';
                  errorDetailsHtml += '<div class="box-content">' + escapedExpected + '</div>';
                  errorDetailsHtml += '</div>';
                  errorDetailsHtml += '<div class="actual-box">';
                  errorDetailsHtml += '<div class="box-label">❌ Actual</div>';
                  errorDetailsHtml += '<div class="box-content">' + escapedActual + '</div>';
                  errorDetailsHtml += '</div>';
                  errorDetailsHtml += '</div>';
                }

                // Show error message
                errorDetailsHtml += '<div class="log-section"><div class="log-header">📋 Error Message</div>';
                errorDetailsHtml += '<div class="output-text">' + escapedError + '</div></div>';

                // Show output if different
                if (outputMsg !== errorMsg && outputMsg !== 'No output') {
                  errorDetailsHtml += '<div class="log-section"><div class="log-header">📄 Test Output / Log</div>';
                  errorDetailsHtml += '<div class="output-text">' + escapedOutput + '</div></div>';
                }

                errorDetailsHtml += '<div class="log-section"><div class="log-header">ℹ️  Test Information</div>';
                errorDetailsHtml += '<div class="output-text"><strong>Consumer:</strong> ' + test.consumerId + '<br>';
                errorDetailsHtml += '<strong>Duration:</strong> ' + (test.duration / 1000).toFixed(2) + 's</div></div>';
                errorDetailsHtml += '</div>';

                const detailsCell =
                  test.outcome === 'failure'
                    ? '<span class="details-toggle" onclick="toggleDetails(\'' +
                      detailsId +
                      '\')">📋 View Complete Log</span>' +
                      '<div id="' +
                      detailsId +
                      '" class="details-content">' +
                      errorDetailsHtml +
                      '</div>'
                    : '✅';
                return `
						<tr class="${test.outcome === 'failure' ? 'failure-highlight' : ''}">
							<td>${test.testId}</td>
							<td title="${test.consumerId}">${test.consumerId.split('-').slice(1, 3).join('-')}</td>
							<td><span class="badge ${test.outcome}">${test.outcome.toUpperCase()}</span></td>
							<td>${(test.duration / 1000).toFixed(2)}s</td>
							<td>${detailsCell}</td>
						</tr>
						`;
              })
              .join('')}
					</tbody>
				</table>
			</div>
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
</html>`;

  try {
    const absolutePath = path.resolve(filename);
    fs.writeFileSync(filename, html);
    return absolutePath;
  } catch (error) {
    console.error(`\n❌ Failed to generate HTML report:`, error);
    throw error;
  }
}

/**
 * Generate JSON report
 */
export function generateJsonReport(data: ReportData): string {
  // Create reports directory if it doesn't exist
  if (!fs.existsSync('reports')) {
    fs.mkdirSync('reports');
  }

  // Generate filename
  let filename = `reports/results-${data.runId}.json`;
  if (fs.existsSync(filename)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    filename = `reports/results-${data.runId}-${timestamp}.json`;
  }

  const elapsed = (Date.now() - data.startTime) / 1000;
  const successCount = data.completedTests.filter((t) => t.outcome === 'success').length;
  const failureCount = data.completedTests.filter((t) => t.outcome === 'failure').length;

  // Group by category
  const byCategory: Record<string, { passed: number; failed: number; total: number }> = {};
  for (const test of data.completedTests) {
    const category = test.testId.split('-')[0];
    if (!byCategory[category]) {
      byCategory[category] = { passed: 0, failed: 0, total: 0 };
    }
    byCategory[category].total++;
    if (test.outcome === 'success') {
      byCategory[category].passed++;
    } else {
      byCategory[category].failed++;
    }
  }

  const jsonReport = {
    runId: data.runId,
    timestamp: new Date().toISOString(),
    summary: {
      total: data.completedTests.length,
      passed: successCount,
      failed: failureCount,
      successRate: ((successCount / data.completedTests.length) * 100).toFixed(1),
      duration: elapsed,
    },
    categories: byCategory,
    tests: data.completedTests.map((test) => ({
      testId: test.testId,
      consumerId: test.consumerId,
      outcome: test.outcome,
      duration: test.duration,
      error: test.error,
      output: test.output,
    })),
    consumers: Array.from(data.consumers.values()),
    system: systemInfo,
  };

  try {
    const absolutePath = path.resolve(filename);
    fs.writeFileSync(filename, JSON.stringify(jsonReport, null, 2));
    return absolutePath;
  } catch (error) {
    console.error(`\n❌ Failed to generate JSON report:`, error);
    throw error;
  }
}
