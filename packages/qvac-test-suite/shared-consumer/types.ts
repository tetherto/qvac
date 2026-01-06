export interface TestMessage {
	testId: string;
	params: any;
	expectation: any;
	expectedOutcome?: string;
}

export interface TestAssignment {
	status: string;
	uniqueTestId?: string;
	test?: TestMessage;
	totalTests?: number;
}

export interface TestResult {
	output: string;
	passed: boolean;
	modelId?: string;
}

export interface TestExecutor {
	executeTest(
		testId: string,
		modelId: string | null,
		params: any,
		expectation: any
	): Promise<TestResult>;
}


