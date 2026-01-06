import type { MqttClient } from 'mqtt';
import type { TestDefinition } from '../types/test-definition.js';
import {
  consumerRegistrationSchema,
  testRequestSchema,
  testStartSchema,
  testResultSchema,
  heartbeatSchema,
  type TestResult as MqttTestResult,
} from '../schemas/messages.js';
import { generateHtmlReport, generateJsonReport, type ReportData } from '../utils/report-generator.js';

interface TestCase {
  id: string; // Unique test ID
  testId: string; // Test type
  payload: string;
  metadata: Record<string, unknown>; // Test metadata
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
}

// Test result type imported from schemas
type TestResult = MqttTestResult;

export class BatchOrchestrator {
  private client: MqttClient;
  private runId: string;
  private allowWildcardConsumers: boolean;
  private consumerTimeoutSec: number;
  private testQueue: TestCase[] = [];
  private assignedTests = new Map<string, TestAssignment>(); // uniqueTestId -> assignment
  private completedTests = new Map<string, TestResult>(); // uniqueTestId -> result
  private consumers = new Map<string, ConsumerInfo>(); // consumerId -> info
  private startTime = 0;
  private batchStarted = false;
  private shutdownTimer?: NodeJS.Timeout;
  private consumerTimeoutTimer?: NodeJS.Timeout;

  constructor(
    client: MqttClient,
    runId: string,
    allowWildcardConsumers: boolean = false,
    consumerTimeoutSec: number = 30
  ) {
    this.client = client;
    this.runId = runId;
    this.allowWildcardConsumers = allowWildcardConsumers;
    this.consumerTimeoutSec = consumerTimeoutSec;
    this.setupMqttHandlers();
  }

  private setupMqttHandlers() {
    this.client.on('connect', () => {
      console.log('✅ Producer connected to MQTT broker');
      console.log(`🔑 Run ID: ${this.runId}`);
      console.log(`🌐 Wildcard consumers: ${this.allowWildcardConsumers ? 'allowed' : 'disabled'}`);

      // Subscribe to all coordination topics
      this.client.subscribe(
        ['qvac/register', 'qvac/request-test', 'qvac/test-start', 'qvac/results', 'qvac/heartbeat'],
        { qos: 1 },
        (err) => {
          if (err) {
            console.error('❌ Failed to subscribe:', err);
            process.exit(1);
          }
          console.log('📡 Subscribed to coordination topics');
        }
      );
    });

    this.client.on('message', (topic, payload) => {
      try {
        const message = JSON.parse(payload.toString());

        const isWildcardConsumer = message.runId === '*';
        const isMatchingRunId = message.runId === this.runId;

        if (!isMatchingRunId && !(isWildcardConsumer && this.allowWildcardConsumers)) {
          return;
        }

        switch (topic) {
          case 'qvac/register':
            this.handleConsumerRegistration(message);
            break;
          case 'qvac/request-test':
            this.handleTestRequest(message);
            break;
          case 'qvac/test-start':
            this.handleTestStart(message);
            break;
          case 'qvac/results':
            this.handleTestResult(message);
            break;
          case 'qvac/heartbeat':
            this.handleHeartbeat(message);
            break;
        }
      } catch (error) {
        console.error(`❌ Error handling ${topic}:`, error);
      }
    });

    this.client.on('error', (err) => {
      console.error('❌ MQTT error:', err);
    });
  }

  private handleConsumerRegistration(rawMessage: unknown) {
    const message = consumerRegistrationSchema.parse(rawMessage);
    const { consumerId, platform } = message;
    const now = Date.now();

    // Cancel consumer timeout on first registration
    if (this.consumers.size === 0 && this.consumerTimeoutTimer) {
      clearTimeout(this.consumerTimeoutTimer);
      this.consumerTimeoutTimer = undefined;
    }

    this.consumers.set(consumerId, {
      consumerId,
      platform,
      registeredAt: now,
      lastSeen: now,
      testsCompleted: 0,
      testsRunning: 0,
    });

    console.log(`\n🔌 Consumer registered: ${consumerId} (${platform})`);
    this.displayStatus();

    // Send acknowledgment
    this.client.publish(
      `qvac/register-ack/${consumerId}`,
      JSON.stringify({ runId: this.runId, status: 'registered', totalTests: this.testQueue.length }),
      { qos: 1 }
    );
  }

  private handleTestRequest(rawMessage: unknown) {
    const message = testRequestSchema.parse(rawMessage);
    const { consumerId } = message;
    const consumer = this.consumers.get(consumerId);

    if (!consumer) {
      console.warn(`⚠️  Test request from unregistered consumer: ${consumerId}`);
      return;
    }

    consumer.lastSeen = Date.now();

    // Find next available test in queue
    const nextTest = this.getNextTestForConsumer(consumerId);

    if (!nextTest) {
      // No more tests - signal queue empty
      this.client.publish(
        `qvac/test-assigned/${consumerId}`,
        JSON.stringify({ runId: this.runId, status: 'queue-empty' }),
        { qos: 1 }
      );
      console.log(`📭 No more tests for ${consumerId}`);
      return;
    }

    // Assign test
    const assignment: TestAssignment = {
      testCase: nextTest,
      consumerId,
      assignedAt: Date.now(),
      // Use max of: 2x estimate OR 70s (to match consumer 60s + 10s MQTT buffer)
      timeoutMs: Math.max(nextTest.estimatedDurationMs * 2, 70000),
    };

    this.assignedTests.set(nextTest.id, assignment);
    consumer.testsRunning++;

    // Remove from queue
    this.testQueue = this.testQueue.filter((t) => t.id !== nextTest.id);

    // Send test to consumer
    this.client.publish(
      `qvac/test-assigned/${consumerId}`,
      JSON.stringify({
        runId: this.runId,
        status: 'assigned',
        uniqueTestId: nextTest.id,
        test: JSON.parse(nextTest.payload),
      }),
      { qos: 1 }
    );

    console.log(`📤 Assigned ${nextTest.testId} (${nextTest.id}) to ${consumerId}`);
    this.displayStatus();
  }

  private handleTestStart(rawMessage: unknown) {
    const message = testStartSchema.parse(rawMessage);
    const { consumerId, uniqueTestId } = message;
    const assignment = this.assignedTests.get(uniqueTestId);

    if (!assignment) {
      console.warn(`⚠️  Test start for unknown test: ${uniqueTestId}`);
      return;
    }

    assignment.startedAt = Date.now();
    console.log(`▶️  Test ${assignment.testCase.testId} started by ${consumerId}`);
  }

  private handleTestResult(rawMessage: unknown) {
    const message = testResultSchema.parse(rawMessage);
    const { consumerId, uniqueTestId, outcome, duration } = message;
    const assignment = this.assignedTests.get(uniqueTestId);

    if (!assignment) {
      console.warn(`⚠️  Result for unknown test: ${uniqueTestId}`);
      return;
    }

    // Update consumer stats
    const consumer = this.consumers.get(consumerId);
    if (consumer) {
      consumer.testsCompleted++;
      consumer.testsRunning--;
      consumer.lastSeen = Date.now();
    }

    // Store result
    this.completedTests.set(uniqueTestId, message);
    this.assignedTests.delete(uniqueTestId);

    const statusIcon = outcome === 'success' ? '✅' : '❌';
    console.log(`${statusIcon} Test ${assignment.testCase.testId} ${outcome} (${duration}ms) - ${consumerId}`);

    if (message.error) {
      // Show full error, but split long errors into multiple lines
      const errorLines = message.error.split('\n');
      if (errorLines.length > 5) {
        console.log(`   Error: ${errorLines.slice(0, 5).join('\n   ')}`);
        console.log(`   ... (${errorLines.length - 5} more lines)`);
      } else {
        console.log(`   Error: ${message.error}`);
      }
    }

    this.displayStatus();
    this.checkBatchComplete();
  }

  private handleHeartbeat(rawMessage: unknown) {
    const message = heartbeatSchema.parse(rawMessage);
    const { consumerId } = message;
    const consumer = this.consumers.get(consumerId);
    if (consumer) {
      consumer.lastSeen = Date.now();
    }
  }

  private getNextTestForConsumer(_consumerId: string): TestCase | null {
    // Simple FIFO for now - could be enhanced with dependency-aware scheduling
    return this.testQueue.length > 0 ? this.testQueue[0] : null;
  }

  private checkBatchComplete() {
    const queueEmpty = this.testQueue.length === 0;
    const noAssignedTests = this.assignedTests.size === 0;

    if (queueEmpty && noAssignedTests) {
      this.completeBatch();
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
      for (const uniqueTestId of timeouts) {
        const assignment = this.assignedTests.get(uniqueTestId);
        if (assignment) {
          console.log(`   - ${assignment.testCase.testId} (${assignment.consumerId})`);

          // Create timeout result
          const timeoutResult: TestResult = {
            runId: this.runId,
            consumerId: assignment.consumerId,
            testId: assignment.testCase.testId,
            uniqueTestId,
            outcome: 'failure',
            duration: Date.now() - assignment.assignedAt,
            timestamp: new Date().toISOString(),
            error: `Test timed out after ${assignment.timeoutMs}ms`,
          };

          this.completedTests.set(uniqueTestId, timeoutResult);
          this.assignedTests.delete(uniqueTestId);

          // Update consumer stats
          const consumer = this.consumers.get(assignment.consumerId);
          if (consumer) {
            consumer.testsRunning--;
          }
        }
      }

      this.checkBatchComplete();
    }
  }

  private displayStatus() {
    const total = this.testQueue.length + this.assignedTests.size + this.completedTests.size;
    const completed = this.completedTests.size;
    const running = this.assignedTests.size;
    const queued = this.testQueue.length;
    const consumers = this.consumers.size;

    console.log(
      `\n📊 Status: ${completed}/${total} completed | ${running} running | ${queued} queued | ${consumers} consumers\n`
    );
  }

  private completeBatch() {
    if (this.shutdownTimer) return; // Already shutting down

    const duration = Date.now() - this.startTime;
    const totalTests = this.completedTests.size;
    const successCount = Array.from(this.completedTests.values()).filter((r) => r.outcome === 'success').length;
    const failureCount = totalTests - successCount;

    console.log(`\n${'='.repeat(80)}`);
    console.log('🎉 BATCH COMPLETE');
    console.log('='.repeat(80));
    console.log(`⏱️  Total Duration: ${(duration / 1000).toFixed(2)}s`);
    console.log(`📝 Total Tests: ${totalTests}`);
    console.log(`✅ Passed: ${successCount}`);
    console.log(`❌ Failed: ${failureCount}`);
    console.log(`📈 Success Rate: ${((successCount / totalTests) * 100).toFixed(1)}%`);
    console.log('\n👥 Consumer Stats:');

    for (const consumer of this.consumers.values()) {
      console.log(`   - ${consumer.consumerId} (${consumer.platform}): ${consumer.testsCompleted} tests`);
    }

    console.log('\n📋 Test Results by Category:\n');
    this.displayResultsByCategory();

    // Generate reports
    try {
      const reportData: ReportData = {
        runId: this.runId,
        completedTests: Array.from(this.completedTests.values()),
        consumers: this.consumers,
        startTime: this.startTime,
      };

      const htmlPath = generateHtmlReport(reportData);
      const jsonPath = generateJsonReport(reportData);

      console.log(`\n📄 Reports generated:`);
      console.log(`   HTML: ${htmlPath}`);
      console.log(`   JSON: ${jsonPath}`);
    } catch (error) {
      console.error('\n⚠️  Failed to generate reports:', error);
    }

    // Signal all consumers to shutdown
    this.client.publish(
      'qvac/batch-complete',
      JSON.stringify({
        runId: this.runId,
        status: 'complete',
        totalTests,
        successCount,
        failureCount,
        duration,
      }),
      { qos: 1 }
    );

    // Shutdown after 2 seconds
    this.shutdownTimer = setTimeout(() => {
      console.log('\n👋 Shutting down producer...\n');
      this.client.end(false, {}, () => process.exit(0));
    }, 2000);
  }

  private displayResultsByCategory() {
    const categories = new Map<string, { passed: number; failed: number }>();

    for (const result of this.completedTests.values()) {
      // Extract category from testId
      let category = result.testId;
      if (category.includes('-')) {
        category = category.split('-')[0];
      }

      if (!categories.has(category)) {
        categories.set(category, { passed: 0, failed: 0 });
      }

      const stats = categories.get(category)!;
      if (result.outcome === 'success') {
        stats.passed++;
      } else {
        stats.failed++;
      }
    }

    for (const [category, stats] of categories) {
      const total = stats.passed + stats.failed;
      const rate = ((stats.passed / total) * 100).toFixed(0);
      console.log(`   ${category.padEnd(20)} ${stats.passed}/${total} (${rate}%)`);
    }
  }

  public buildTestQueue(tests: TestDefinition[]) {
    console.log('🔨 Building test queue...\n');

    let counter = 0;
    let skippedCount = 0;

    for (const test of tests) {
      // Skip tests with skip field
      if (test.skip) {
        skippedCount++;
        console.log(
          `⏭️  Skipping ${test.testId}: ${test.skip.reason}${test.skip.issue ? ` (${test.skip.issue})` : ''}`
        );
        continue;
      }

      const testCase: TestCase = {
        id: `test-${Date.now()}-${counter++}`,
        testId: test.testId,
        payload: JSON.stringify({
          testId: test.testId,
          params: test.params,
          expectation: test.expectation,
        }),
        metadata: test.metadata || {},
        estimatedDurationMs: test.metadata?.estimatedDurationMs || 10000,
      };
      this.testQueue.push(testCase);
    }

    if (skippedCount > 0) {
      console.log(`\n⏭️  Skipped ${skippedCount} tests\n`);
    }

    // Group by category from metadata for reporting
    const byCategory = new Map<string, number>();
    for (const test of this.testQueue) {
      const category = (typeof test.metadata?.category === 'string' ? test.metadata.category : null) || 'uncategorized';
      byCategory.set(category, (byCategory.get(category) || 0) + 1);
    }

    console.log(`📦 Built ${this.testQueue.length} tests:`);
    for (const [category, count] of byCategory) {
      console.log(`   - ${category}: ${count} tests`);
    }
    console.log();
  }

  public start() {
    if (this.batchStarted) {
      console.warn('⚠️  Batch already started');
      return;
    }

    this.batchStarted = true;
    this.startTime = Date.now();

    console.log('🚀 Batch orchestration started');
    console.log(`📋 Total tests: ${this.testQueue.length}`);
    console.log(`⏳ Waiting for consumers to register (timeout: ${this.consumerTimeoutSec}s)...\n`);

    // Start consumer connection timeout
    this.consumerTimeoutTimer = setTimeout(() => {
      if (this.consumers.size === 0) {
        console.error(`\n❌ No consumers connected within ${this.consumerTimeoutSec}s timeout`);
        console.error('   Make sure the consumer is running with the same --runId');
        this.client.end(false, {}, () => process.exit(1));
      }
    }, this.consumerTimeoutSec * 1000);

    // Start timeout checker (every 10 seconds)
    setInterval(() => this.checkTimeouts(), 10000);

    // Display status every 30 seconds
    setInterval(() => {
      if (this.assignedTests.size > 0 || this.testQueue.length > 0) {
        this.displayStatus();
      }
    }, 30000);
  }

  public shutdown() {
    console.log('\n⚠️  Shutting down...');
    this.client.end(false, {}, () => process.exit(0));
  }
}

// Export for use as library
// Main execution removed - will be handled by CLI
