// Sample test definitions for Step 1 validation
export const tests = [
  {
    testId: 'sample-test-1',
    params: { input: 'hello world' },
    expectation: {
      validation: 'contains-all',
      contains: ['hello', 'world'],
    },
    metadata: { category: 'sample', timeout: 5000 },
  },
  {
    testId: 'sample-test-2',
    params: { value: 42 },
    expectation: {
      validation: 'numeric-range',
      min: 0,
      max: 100,
    },
  },
];
