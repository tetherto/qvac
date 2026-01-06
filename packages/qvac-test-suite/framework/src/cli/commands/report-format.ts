import * as fs from 'node:fs';

interface FormatOptions {
  input: string;
  format: string;
  output?: string;
}

export async function reportFormat(options: FormatOptions) {
  try {
    // Load comparison JSON
    const comparisonData = fs.readFileSync(options.input, 'utf-8') as string;
    const comparison = JSON.parse(comparisonData);

    if (options.format === 'markdown') {
      const markdown = generateMarkdown(comparison);

      if (options.output) {
        fs.writeFileSync(options.output, markdown);
        console.log(`✅ Markdown report saved: ${options.output}`);
      } else {
        console.log(markdown);
      }
    } else {
      throw new Error(`Unsupported format: ${options.format}`);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ Format failed:', errorMessage);
    process.exit(1);
  }
}

function generateMarkdown(comparison: {
  metadata: {
    baseline: { runId: string };
    current: { runId: string };
  };
  summary: {
    baseline: { total: number; passed: number; failed: number };
    current: { total: number; passed: number; failed: number };
    delta: number;
  };
  categories: Record<
    string,
    {
      baseline: { passed: number; total: number };
      current: { passed: number; total: number };
      delta: number;
    }
  >;
  changes: {
    newFailures: Array<{ testId: string; error?: string }>;
    fixedTests: Array<{ testId: string }>;
    newTests: string[];
    removedTests: string[];
  };
}): string {
  const lines: string[] = [];

  lines.push('## 🧪 Test Results\n');
  lines.push(`**Baseline**: \`${comparison.metadata.baseline.runId}\``);
  lines.push(`**Current**: \`${comparison.metadata.current.runId}\`\n`);

  // Summary
  const baselineRateNum = (comparison.summary.baseline.passed / comparison.summary.baseline.total) * 100;
  const currentRateNum = (comparison.summary.current.passed / comparison.summary.current.total) * 100;
  const baselineRate = baselineRateNum.toFixed(1);
  const currentRate = currentRateNum.toFixed(1);
  const rateDeltaNum = currentRateNum - baselineRateNum;
  const rateDelta = rateDeltaNum.toFixed(1);

  lines.push('### Summary\n');
  lines.push(
    `- ${comparison.summary.current.passed}/${comparison.summary.current.total} tests passed (${currentRate}%)`
  );
  lines.push(
    `- Baseline: ${comparison.summary.baseline.passed}/${comparison.summary.baseline.total} (${baselineRate}%)`
  );
  lines.push(
    `- Delta: ${comparison.summary.delta > 0 ? '+' : ''}${comparison.summary.delta} tests, ${rateDeltaNum > 0 ? '+' : ''}${rateDelta}%\n`
  );

  // Per-category results
  lines.push('### Per-Category Results\n');
  lines.push('| Category | Current | Baseline | Delta |');
  lines.push('|----------|---------|----------|-------|');

  for (const [category, data] of Object.entries(comparison.categories)) {
    const currentRateNum = (data.current.passed / data.current.total) * 100;
    const baselineRateNum = (data.baseline.passed / data.baseline.total) * 100;
    const currentRate = currentRateNum.toFixed(1);
    const baselineRate = baselineRateNum.toFixed(1);
    const deltaTests = data.delta > 0 ? `+${data.delta}` : data.delta < 0 ? `${data.delta}` : '0';
    const deltaPercentNum = currentRateNum - baselineRateNum;
    const deltaPercent = deltaPercentNum.toFixed(1);
    const deltaStr = `${deltaTests} tests, ${deltaPercentNum > 0 ? '+' : ''}${deltaPercent}%`;
    const emoji = data.delta > 0 ? ' ✅' : data.delta < 0 ? ' ❌' : '';

    lines.push(
      `| ${category} | ${data.current.passed}/${data.current.total} (${currentRate}%) | ${data.baseline.passed}/${data.baseline.total} (${baselineRate}%) | ${deltaStr}${emoji} |`
    );
  }

  lines.push('');

  // New failures
  if (comparison.changes.newFailures.length > 0) {
    lines.push('### 🔴 New Failures\n');
    lines.push('| Test ID | Error |');
    lines.push('|---------|-------|');
    for (const failure of comparison.changes.newFailures.slice(0, 10)) {
      const error = failure.error ? failure.error.substring(0, 50) : 'N/A';
      lines.push(`| \`${failure.testId}\` | ${error} |`);
    }
    if (comparison.changes.newFailures.length > 10) {
      lines.push(`\n_... and ${comparison.changes.newFailures.length - 10} more_`);
    }
    lines.push('');
  }

  // Fixed tests
  if (comparison.changes.fixedTests.length > 0) {
    lines.push('### ✅ Fixed Tests\n');
    lines.push('| Test ID |');
    lines.push('|---------|');
    for (const fixed of comparison.changes.fixedTests.slice(0, 10)) {
      lines.push(`| \`${fixed.testId}\` |`);
    }
    if (comparison.changes.fixedTests.length > 10) {
      lines.push(`\n_... and ${comparison.changes.fixedTests.length - 10} more_`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
