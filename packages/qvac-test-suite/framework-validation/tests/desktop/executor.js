// Simple executor for Step 3 validation
// Just echoes back the test params as output

export const executor = {
  async executeTest(testId, context, params, expectation) {
    console.log(`  [Executor] Running ${testId} with params:`, params);

    // Simulate some work
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Simple validation based on expectation type
    if (expectation.validation === 'contains-all') {
      const output = JSON.stringify(params);
      const allPresent = expectation.contains.every((str) => output.includes(str));
      return {
        passed: allPresent,
        output: `Checked for: ${expectation.contains.join(', ')} in ${output}`,
      };
    }

    if (expectation.validation === 'numeric-range') {
      const value = params.value;
      const inRange =
        (expectation.min === undefined || value >= expectation.min) &&
        (expectation.max === undefined || value <= expectation.max);
      return {
        passed: inRange,
        output: `Value ${value} ${inRange ? 'is' : 'is not'} in range [${expectation.min}, ${expectation.max}]`,
      };
    }

    // Default: pass with output
    return {
      passed: true,
      output: `Executed ${testId} successfully`,
    };
  },
};
