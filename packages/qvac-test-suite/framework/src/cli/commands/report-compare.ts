import * as fs from 'node:fs';
import * as path from 'node:path';

interface CompareOptions {
  baseline: string;
  current: string;
  output: string;
}

interface TestResult {
  testId: string;
  outcome: 'success' | 'failure';
  duration: number;
  error?: string;
}

interface Report {
  runId: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    duration: number;
  };
  categories: Record<string, { passed: number; failed: number; total: number }>;
  tests: TestResult[];
}

export async function reportCompare(options: CompareOptions) {
  try {
    console.log('📊 Comparing test results...\n');

    // Load baseline
    const baselineData = fs.readFileSync(options.baseline, 'utf-8') as string;
    const baseline: Report = JSON.parse(baselineData);
    console.log(`📋 Baseline: ${baseline.runId} (${baseline.summary.passed}/${baseline.summary.total} passed)`);

    // Load current
    const currentData = fs.readFileSync(options.current, 'utf-8') as string;
    const current: Report = JSON.parse(currentData);
    console.log(`📋 Current:  ${current.runId} (${current.summary.passed}/${current.summary.total} passed)\n`);

    // Build test result maps - handle duplicates by keeping ALL occurrences
    const baselineTestsMap = new Map<string, TestResult[]>();
    for (const test of baseline.tests) {
      if (!baselineTestsMap.has(test.testId)) {
        baselineTestsMap.set(test.testId, []);
      }
      baselineTestsMap.get(test.testId)!.push(test);
    }

    const currentTestsMap = new Map<string, TestResult[]>();
    for (const test of current.tests) {
      if (!currentTestsMap.has(test.testId)) {
        currentTestsMap.set(test.testId, []);
      }
      currentTestsMap.get(test.testId)!.push(test);
    }

    // Find differences - compare by taking worst outcome if duplicates exist
    const newFailures: Array<{ testId: string; error?: string }> = [];
    const fixedTests: Array<{ testId: string }> = [];
    const newTests: string[] = [];
    const removedTests: string[] = [];

    // Check for new failures and fixes
    for (const [testId, currentTests] of currentTestsMap) {
      const baselineTests = baselineTestsMap.get(testId);

      if (!baselineTests) {
        newTests.push(testId);
        continue;
      }

      // Check if any current run failed when all baseline runs passed
      const baselineAllPassed = baselineTests.every((t) => t.outcome === 'success');
      const currentHasFailure = currentTests.some((t) => t.outcome === 'failure');
      const currentAllPassed = currentTests.every((t) => t.outcome === 'success');
      const baselineHasFailure = baselineTests.some((t) => t.outcome === 'failure');

      if (baselineAllPassed && currentHasFailure) {
        const failedTest = currentTests.find((t) => t.outcome === 'failure')!;
        newFailures.push({ testId, error: failedTest.error });
      } else if (baselineHasFailure && currentAllPassed) {
        fixedTests.push({ testId });
      }
    }

    // Check for removed tests
    for (const testId of baselineTestsMap.keys()) {
      if (!currentTestsMap.has(testId)) {
        removedTests.push(testId);
      }
    }

    // Category comparison
    const categoryChanges: Record<
      string,
      { baseline: { passed: number; total: number }; current: { passed: number; total: number }; delta: number }
    > = {};

    for (const category in current.categories) {
      const curr = current.categories[category];
      const base = baseline.categories[category] || { passed: 0, failed: 0, total: 0 };
      categoryChanges[category] = {
        baseline: { passed: base.passed, total: base.total },
        current: { passed: curr.passed, total: curr.total },
        delta: curr.passed - base.passed,
      };
    }

    // Build comparison result
    const comparison = {
      metadata: {
        baseline: { runId: baseline.runId, timestamp: new Date().toISOString() },
        current: { runId: current.runId, timestamp: new Date().toISOString() },
      },
      summary: {
        baseline: baseline.summary,
        current: current.summary,
        delta: current.summary.passed - baseline.summary.passed,
      },
      categories: categoryChanges,
      changes: {
        newFailures,
        fixedTests,
        newTests,
        removedTests,
      },
    };

    // Write comparison
    const outputPath = path.resolve(options.output);
    fs.writeFileSync(outputPath, JSON.stringify(comparison, null, 2));

    console.log(`✅ Comparison saved: ${outputPath}`);
    console.log(`\n📊 Summary:`);
    console.log(`   New failures: ${newFailures.length}`);
    console.log(`   Fixed tests: ${fixedTests.length}`);
    console.log(`   New tests: ${newTests.length}`);
    console.log(`   Removed tests: ${removedTests.length}`);
    console.log(`   Overall delta: ${comparison.summary.delta > 0 ? '+' : ''}${comparison.summary.delta}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ Comparison failed:', errorMessage);
    process.exit(1);
  }
}
