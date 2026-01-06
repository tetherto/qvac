import mqtt, { type IClientPublishOptions, type MqttClient } from "mqtt";
import { env } from "./env";
import { TestBuilder } from "./test-builders";
import { generateHtmlReport, type ReportData, type ReportTestResult, type ReportConsumerInfo } from "../shared-utils/report-generator";
import { getArgValue } from "../shared-utils/args";

interface TestCase {
	id: string; // Unique test ID
	testId: string; // Test type
	payload: string;
	dependency: string; // Model dependency: "llm", "whisper", "embeddings", "none"
	estimatedDurationMs: number;
}

interface TestAssignment {
	testCase: TestCase;
	consumerId: string;
	assignedAt: number;
	startedAt?: number;
	timeoutMs: number;
}

interface ConsumerInfo {
	consumerId: string;
	platform: string;
	registeredAt: number;
	lastSeen: number;
	testsCompleted: number;
	testsRunning: number;
	completedTestIds: Set<string>; // Track which tests this consumer has completed
}

interface TestResult {
	consumerId: string;
	testId: string;
	uniqueTestId: string;
	outcome: "success" | "failure";
	duration: number;
	timestamp: string;
	error?: string;
	output?: string;
	expected?: string;
	actual?: string;
}

export class BatchOrchestrator {
	private client: MqttClient;
	private runId: string;
	private allowWildcardConsumers: boolean;
	private testQueue: TestCase[] = [];
	private assignedTests = new Map<string, TestAssignment>(); // uniqueTestId -> assignment
	private completedTests = new Map<string, TestResult>(); // uniqueTestId -> result
	private consumers = new Map<string, ConsumerInfo>(); // consumerId -> info
	private consumersNotifiedQueueEmpty = new Set<string>(); // Track which consumers have been notified queue is empty
	private allTestIds: string[] = []; // All test IDs that need to be run by each consumer
	private startTime = 0;
	private batchStarted = false;
	private shutdownTimer?: NodeJS.Timeout;
	private lastActiveConsumerLog = 0; // Timestamp of last active consumer log (to avoid spam)

	constructor(brokerUrl: string, runId: string, allowWildcardConsumers: boolean = false) {
		this.client = mqtt.connect(brokerUrl);
		this.runId = runId;
		this.allowWildcardConsumers = allowWildcardConsumers;
		this.setupMqttHandlers();
	}

	private setupMqttHandlers() {
		this.client.on("connect", () => {
			console.log("✅ Producer connected to MQTT broker");
			console.log(`🔑 Run ID: ${this.runId}`);
			console.log(`🌐 Wildcard consumers: ${this.allowWildcardConsumers ? 'allowed' : 'disabled'}`);
			
			// Subscribe to all coordination topics
			this.client.subscribe([
				"qvac/register",
				"qvac/request-test",
				"qvac/test-start",
				"qvac/results",
				"qvac/heartbeat",
			], { qos: 1 }, (err) => {
				if (err) {
					console.error("❌ Failed to subscribe:", err);
					process.exit(1);
				}
				console.log("📡 Subscribed to coordination topics");
			});
		});

		this.client.on("message", (topic, payload) => {
			try {
				const message = JSON.parse(payload.toString());
				
				const isWildcardConsumer = message.runId === '*';
				const isMatchingRunId = message.runId === this.runId;
				
				if (!isMatchingRunId && !(isWildcardConsumer && this.allowWildcardConsumers)) {
					return;
				}
				
				switch (topic) {
					case "qvac/register":
						this.handleConsumerRegistration(message);
						break;
					case "qvac/request-test":
						this.handleTestRequest(message);
						break;
					case "qvac/test-start":
						this.handleTestStart(message);
						break;
					case "qvac/results":
						this.handleTestResult(message);
						break;
					case "qvac/heartbeat":
						this.handleHeartbeat(message);
						break;
				}
			} catch (error) {
				console.error(`❌ Error handling ${topic}:`, error);
			}
		});

		this.client.on("error", (err) => {
			console.error("❌ MQTT error:", err);
		});
	}

	private handleConsumerRegistration(message: any) {
		const { consumerId, platform } = message;
		const now = Date.now();
		
		this.consumers.set(consumerId, {
			consumerId,
			platform,
			registeredAt: now,
			lastSeen: now,
			testsCompleted: 0,
			testsRunning: 0,
			completedTestIds: new Set<string>(), // Track which tests this consumer has completed
		});

		// Reset queue-empty notification status for this consumer (in case of re-registration)
		this.consumersNotifiedQueueEmpty.delete(consumerId);

		console.log(`\n🔌 Consumer registered: ${consumerId} (${platform})`);
		console.log(`   This consumer will run ALL ${this.allTestIds.length} tests`);
		this.displayStatus();

		// Send acknowledgment
		this.client.publish(
			`qvac/register-ack/${consumerId}`,
			JSON.stringify({ runId: this.runId, status: "registered", totalTests: this.testQueue.length }),
			{ qos: 1 },
		);
	}

	private handleTestRequest(message: any) {
		const { consumerId } = message;
		const consumer = this.consumers.get(consumerId);
		
		if (!consumer) {
			console.warn(`⚠️  Test request from unregistered consumer: ${consumerId}`);
			return;
		}

		consumer.lastSeen = Date.now();

		// Find next available test in queue with fair distribution
		const nextTest = this.getNextTestForConsumer(consumerId);

		if (!nextTest) {
			// Check if this consumer has completed all tests
			if (consumer.completedTestIds.size >= this.allTestIds.length) {
				// Consumer has completed all tests - signal queue empty
				this.consumersNotifiedQueueEmpty.add(consumerId);
				this.client.publish(
					`qvac/test-assigned/${consumerId}`,
					JSON.stringify({ runId: this.runId, status: "queue-empty" }),
					{ qos: 1 },
				);
				console.log(`📭 ${consumerId.split('-').slice(1, 3).join('-')} completed all ${this.allTestIds.length} tests`);
				// Check if batch should complete after notifying this consumer
				// Use a small delay to allow consumer to process the message
				setTimeout(() => this.checkBatchComplete(), 1000);
			}
			return;
		}

		// Consumer is getting a test, so remove from notified set (in case they request again)
		this.consumersNotifiedQueueEmpty.delete(consumerId);

		// Assign test
		const assignment: TestAssignment = {
			testCase: nextTest,
			consumerId,
		assignedAt: Date.now(),
		// Use max of: 2x estimate OR 70s (to match consumer 60s + 10s MQTT buffer)
		timeoutMs: Math.max(nextTest.estimatedDurationMs * 2, 70000),
		};

		// Use consumer-specific key since multiple consumers can run same test
		const assignmentKey = `${nextTest.id}-${consumerId}`;
		this.assignedTests.set(assignmentKey, assignment);
		consumer.testsRunning++;

		// Don't remove from queue - other consumers need to run this test too!
		// The test stays in the queue until all consumers have completed it

		// Send test to consumer
		this.client.publish(
			`qvac/test-assigned/${consumerId}`,
			JSON.stringify({
				runId: this.runId,
				status: "assigned",
				uniqueTestId: nextTest.id,
				test: JSON.parse(nextTest.payload),
			}),
			{ qos: 1 },
		);

		const totalTests = consumer.testsCompleted + consumer.testsRunning;
		console.log(`📤 Assigned ${nextTest.testId} (${nextTest.id}) to ${consumerId} (total: ${totalTests})`);
		this.displayStatus();
	}

	private handleTestStart(message: any) {
		const { consumerId, uniqueTestId } = message;
		const assignmentKey = `${uniqueTestId}-${consumerId}`;
		const assignment = this.assignedTests.get(assignmentKey);

		if (!assignment) {
			console.warn(`⚠️  Test start for unknown test: ${uniqueTestId} (consumer: ${consumerId})`);
			return;
		}

		assignment.startedAt = Date.now();
		console.log(`▶️  Test ${assignment.testCase.testId} started by ${consumerId}`);
	}

	private handleTestResult(message: TestResult) {
		const { consumerId, uniqueTestId, outcome, duration } = message;
		const assignmentKey = `${uniqueTestId}-${consumerId}`;
		const assignment = this.assignedTests.get(assignmentKey);

		if (!assignment) {
			console.warn(`⚠️  Result for unknown test: ${uniqueTestId} (consumer: ${consumerId})`);
			return;
		}

		// Update consumer stats
		const consumer = this.consumers.get(consumerId);
		if (consumer) {
			consumer.testsCompleted++;
			consumer.testsRunning--;
			consumer.lastSeen = Date.now();
			// Mark this test as completed by this consumer
			consumer.completedTestIds.add(uniqueTestId);
		}

		// Store result with consumer-specific key
		// Each consumer's results are stored separately
		const consumerSpecificKey = `${uniqueTestId}-${consumerId}`;
		this.completedTests.set(consumerSpecificKey, message);
		this.assignedTests.delete(assignmentKey);

		const statusIcon = outcome === "success" ? "✅" : "❌";
		console.log(
			`${statusIcon} Test ${assignment.testCase.testId} ${outcome} (${duration}ms) - ${consumerId}`,
		);

		if (message.error) {
			console.log(`   Error: ${message.error.substring(0, 100)}`);
		}

		this.displayStatus();
		this.checkBatchComplete();
	}

	private handleHeartbeat(message: any) {
		const { consumerId } = message;
		const consumer = this.consumers.get(consumerId);
		if (consumer) {
			consumer.lastSeen = Date.now();
		}
	}

	private getNextTestForConsumer(consumerId: string): TestCase | null {
		const consumer = this.consumers.get(consumerId);
		if (!consumer) {
			return null;
		}

		// Find the next test that this consumer hasn't completed yet
		// Each consumer should run ALL tests, so we check which tests they've already done
		// Multiple consumers can run the same test simultaneously
		return this.testQueue.find(test => !consumer.completedTestIds.has(test.id)) ?? null;
	}

	private checkBatchComplete() {
		// Check if all consumers have completed all tests
		// Don't check queue empty - tests stay in queue for all consumers to run
		const noAssignedTests = this.assignedTests.size === 0;

		// Don't shut down if tests are still assigned
		if (!noAssignedTests) {
			return;
		}

		// Check if any consumer is still running tests
		const anyConsumerRunning = Array.from(this.consumers.values()).some(
			consumer => consumer.testsRunning > 0
		);

		// Don't shut down if any consumer is still running tests
		if (anyConsumerRunning) {
			return;
		}

		// Get all active consumers (those that haven't been notified queue is empty)
		// These are consumers that might still request tests
		const activeConsumers = Array.from(this.consumers.keys()).filter(
			consumerId => !this.consumersNotifiedQueueEmpty.has(consumerId)
		);

		// If there are active consumers that haven't been notified, wait for them
		if (activeConsumers.length > 0) {
			// Log which consumers are still active (but only once per minute to avoid spam)
			const now = Date.now();
			if (!this.lastActiveConsumerLog || now - this.lastActiveConsumerLog > 60000) {
				const activeConsumerInfo = activeConsumers.map(id => {
					const consumer = this.consumers.get(id);
					return `${id.split('-').slice(1, 3).join('-')} (${consumer?.platform || 'unknown'})`;
				}).join(', ');
				console.log(`⏳ Waiting for ${activeConsumers.length} active consumer(s) to finish: ${activeConsumerInfo}`);
				this.lastActiveConsumerLog = now;
			}
			return;
		}

		// All active consumers have been notified queue is empty
		// Double-check: ensure no consumer has tests running (safety check)
		const allConsumersDone = Array.from(this.consumers.values()).every(
			consumer => consumer.testsRunning === 0
		);

		if (allConsumersDone) {
			// Log consumer completion status for debugging
			const consumerStatus = Array.from(this.consumers.entries()).map(([id, info]) => {
				const shortId = id.split('-').slice(1, 3).join('-');
				return `${shortId} (${info.platform}): ${info.testsCompleted} tests, notified: ${this.consumersNotifiedQueueEmpty.has(id)}`;
			}).join('; ');
			console.log(`✅ All consumers have completed - shutting down producer`);
			console.log(`   Consumer status: ${consumerStatus}`);
			this.completeBatch();
		} else {
			// Some consumers still have tests running - log for debugging
			const runningConsumers = Array.from(this.consumers.entries())
				.filter(([_, info]) => info.testsRunning > 0)
				.map(([id, info]) => `${id.split('-').slice(1, 3).join('-')} (${info.platform}): ${info.testsRunning} running`);
			if (runningConsumers.length > 0) {
				console.log(`⏳ Still waiting - consumers with running tests: ${runningConsumers.join(', ')}`);
			}
		}
	}

	private checkTimeouts() {
		const now = Date.now();
		const timeouts: string[] = [];

		for (const [uniqueTestId, assignment] of this.assignedTests) {
			const elapsed = now - assignment.assignedAt;
			if (elapsed > assignment.timeoutMs) {
				timeouts.push(uniqueTestId);
			}
		}

		if (timeouts.length > 0) {
			console.log(`\n⏱️  ${timeouts.length} test(s) timed out:`);
			for (const assignmentKey of timeouts) {
				const assignment = this.assignedTests.get(assignmentKey);
				if (assignment) {
					// Extract test ID from assignment key (format: "testId-consumerId")
					const uniqueTestId = assignment.testCase.id;
					console.log(
						`   - ${assignment.testCase.testId} (${assignment.consumerId})`,
					);

					// Create timeout result
					const timeoutResult: TestResult = {
						consumerId: assignment.consumerId,
						testId: assignment.testCase.testId,
						uniqueTestId,
						outcome: "failure",
						duration: Date.now() - assignment.assignedAt,
						timestamp: new Date().toISOString(),
						error: `Test timed out after ${assignment.timeoutMs}ms`,
					};

					// Use consumer-specific key for timeout result
					this.completedTests.set(assignmentKey, timeoutResult);
					this.assignedTests.delete(assignmentKey);

					// Update consumer stats
					const consumer = this.consumers.get(assignment.consumerId);
					if (consumer) {
						consumer.testsRunning--;
						consumer.testsCompleted++;
						// Mark this test as completed by this consumer (even though it timed out)
						consumer.completedTestIds.add(uniqueTestId);
					}
				}
			}

			this.checkBatchComplete();
		}
	}

	private displayStatus() {
		// Total should be: number of unique tests * number of consumers
		// Each consumer runs ALL tests, so total = uniqueTests * consumers
		const uniqueTests = this.testQueue.length > 0 ? this.testQueue.length : this.allTestIds.length;
		const total = uniqueTests * Math.max(this.consumers.size, 1); // At least 1 to avoid division by zero
		const completed = this.completedTests.size;
		const running = this.assignedTests.size;
		const queued = this.testQueue.length;
		const consumers = this.consumers.size;

		console.log(
			`\n📊 Status: ${completed}/${total} completed (${uniqueTests} unique tests × ${consumers} consumer${consumers !== 1 ? 's' : ''}) | ${running} running | ${queued} queued\n`,
		);
	}

	private completeBatch() {
		if (this.shutdownTimer) return; // Already shutting down

		const duration = Date.now() - this.startTime;
		const totalTests = this.completedTests.size;
		const successCount = Array.from(this.completedTests.values()).filter(
			r => r.outcome === "success",
		).length;
		const failureCount = totalTests - successCount;

		console.log("\n" + "=".repeat(80));
		console.log("🎉 BATCH COMPLETE");
		console.log("=".repeat(80));
		console.log(`⏱️  Total Duration: ${(duration / 1000).toFixed(2)}s`);
		console.log(`📝 Total Tests: ${totalTests}`);
		console.log(`✅ Passed: ${successCount}`);
		console.log(`❌ Failed: ${failureCount}`);
		console.log(`📈 Success Rate: ${((successCount / totalTests) * 100).toFixed(1)}%`);
		console.log("\n👥 Consumer Stats:");
		
		for (const consumer of this.consumers.values()) {
			console.log(
				`   - ${consumer.consumerId} (${consumer.platform}): ${consumer.testsCompleted} tests`,
			);
		}

		console.log("\n📋 Test Results by Category:\n");
		this.displayResultsByCategory();

		// Generate HTML report
		try {
			const reportData: ReportData = {
				runId: this.runId,
				completedTests: Array.from(this.completedTests.values()).map(test => ({
					testId: test.testId,
					consumerId: test.consumerId,
					outcome: test.outcome,
					duration: test.duration,
					error: test.error,
					output: test.output,
					expected: test.expected,
					actual: test.actual,
				} as ReportTestResult)),
				consumers: new Map(Array.from(this.consumers.entries()).map(([id, info]) => [
					id,
					{ consumerId: info.consumerId, platform: info.platform } as ReportConsumerInfo
				])),
				startTime: this.startTime,
			};
			generateHtmlReport(reportData);
		} catch (error) {
			console.error("⚠️  Failed to generate HTML report:", error);
		}

		// Signal all consumers to shutdown
		this.client.publish("qvac/batch-complete", JSON.stringify({ 
			runId: this.runId,
			status: "complete",
			totalTests,
			successCount,
			failureCount,
			duration,
		}), { qos: 1 });

		// Shutdown after 2 seconds
		this.shutdownTimer = setTimeout(() => {
			console.log("\n👋 Shutting down producer...\n");
			this.client.end(false, {}, () => process.exit(0));
		}, 2000);
	}

	private displayResultsByCategory() {
		const categories = new Map<string, { passed: number; failed: number }>();

		for (const result of this.completedTests.values()) {
			// Extract category from testId
			let category = result.testId;
			if (category.includes("-")) {
				category = category.split("-")[0] ?? category;
			}

			if (!categories.has(category)) {
				categories.set(category, { passed: 0, failed: 0 });
			}

			const stats = categories.get(category)!;
			if (result.outcome === "success") {
				stats.passed++;
			} else {
				stats.failed++;
			}
		}

		for (const [category, stats] of categories) {
			const total = stats.passed + stats.failed;
			const rate = ((stats.passed / total) * 100).toFixed(0);
			console.log(
				`   ${category.padEnd(20)} ${stats.passed}/${total} (${rate}%)`,
			);
		}
	}

	public buildTestQueue() {
		console.log("🔨 Building test queue...\n");

		const builder = new TestBuilder();
		
		// Check for --section command line argument
		const section = env.SECTION || "all";
		if (section !== "all") {
			console.log(`📂 Running section: ${section}\n`);
		}
		
		const allTests = section === "all" 
			? builder.buildAllTests()
			: builder.buildTestsBySection([], section);

		// Apply test filtering if TEST_FILTER env var is set
		const testFilter = env.TEST_FILTER || (section !== "all" ? section : undefined);
		let filteredTests = allTests;
		
		if (testFilter && testFilter !== "all") {
			const filters = testFilter.split(',').map(f => f.trim()).filter(Boolean);
			console.log(`🔍 Filtering tests by: ${filters.join(', ')}`);
			
			filteredTests = allTests.filter(test => 
				filters.some(filter => {
					// Normalize filter for common section name mismatches
					// "embedding" section -> match "embed-" prefix or "embeddings" dependency
					const normalizedFilter = filter === "embedding" ? "embed" : filter;
					const normalizedDependency = filter === "embedding" ? "embeddings" : filter;
					
					// Match by testId prefix OR by dependency (e.g., "llm", "whisper", "embeddings")
					return test.testId.startsWith(normalizedFilter) || test.dependency === normalizedDependency;
				})
			);
			
			console.log(`📋 Filtered: ${filteredTests.length} of ${allTests.length} tests\n`);
		}

		let counter = 0;
		for (const test of filteredTests) {
			const testCase: TestCase = {
				id: `test-${Date.now()}-${counter++}`,
				testId: test.testId,
				payload: test.payload,
				dependency: test.dependency,
				estimatedDurationMs: test.estimatedDurationMs,
			};
			this.testQueue.push(testCase);
		}

		// Group by dependency for better reporting
		const byDependency = new Map<string, number>();
		for (const test of this.testQueue) {
			byDependency.set(
				test.dependency,
				(byDependency.get(test.dependency) || 0) + 1,
			);
		}

		console.log(`📦 Built ${this.testQueue.length} tests:`);
		for (const [dep, count] of byDependency) {
			console.log(`   - ${dep}: ${count} tests`);
		}
		console.log();

		// Store all test IDs - each consumer will run ALL of these tests
		this.allTestIds = this.testQueue.map(t => t.id);
		console.log(`📋 Each consumer will run all ${this.allTestIds.length} tests\n`);
	}

	public start() {
		if (this.batchStarted) {
			console.warn("⚠️  Batch already started");
			return;
		}

		this.batchStarted = true;
		this.startTime = Date.now();

		console.log("🚀 Batch orchestration started");
		console.log(`📋 Total tests: ${this.testQueue.length}`);
		console.log("⏳ Waiting for consumers to register...\n");

		// Start timeout checker (every 10 seconds)
		setInterval(() => this.checkTimeouts(), 10000);

		// Display status every 30 seconds
		setInterval(() => {
			if (this.assignedTests.size > 0 || this.testQueue.length > 0) {
				this.displayStatus();
			}
		}, 30000);

		// Periodically check for batch completion (every 5 seconds)
		// This ensures we catch completion even if checkBatchComplete() isn't called
		setInterval(() => {
			if (this.testQueue.length === 0 && this.assignedTests.size === 0) {
				this.checkBatchComplete();
			}
		}, 5000);
	}

	public shutdown() {
		console.log("\n⚠️  Shutting down...");
		this.client.end(false, {}, () => process.exit(0));
	}
}

// Main execution
const orchestrator = new BatchOrchestrator(env.MQTT_BROKER_URL, env.RUN_ID, env.ALLOW_WILDCARD_CONSUMERS);

orchestrator.buildTestQueue();

// Wait for MQTT connection before starting
setTimeout(() => {
	orchestrator.start();
}, 1000);

// Handle shutdown signals
process.on("SIGINT", () => orchestrator.shutdown());
process.on("SIGTERM", () => orchestrator.shutdown());

