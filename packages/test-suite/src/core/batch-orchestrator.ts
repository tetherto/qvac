import * as fs from 'node:fs'
import * as path from 'node:path'
import type { MqttClient } from 'mqtt'
import type { TestDefinition } from '../types/test-definition.js'
import {
  consumerRegistrationSchema,
  testPrepareSchema,
  testStartSchema,
  testResultSchema,
  testReloadSchema,
  heartbeatSchema,
  queueEmptySchema,
  profilingDataSchema,
  type TestResult as MqttTestResult,
  type ProfilerExport
} from '../schemas/messages.js'
import {
  generateHtmlReport,
  generateJsonReport,
  type ReportData,
  type ReportProfilingData
} from '../utils/report-generator.js'
import { getMetricCount } from '../utils/profiler-adapter.js'
import { aggregateMemory, type MemorySummary } from '../utils/memory-aggregator.js'
import { buildMqttSessionEndOptions } from '../utils/mqtt-session.js'

interface TestCase {
  id: string // Unique test ID
  testId: string // Test type
  metadata: Record<string, unknown> // Test metadata (producer-side reporting only)
  suites?: string[]
  estimatedDurationMs: number
}

interface TestAssignment {
  testCase: TestCase
  consumerId: string
  assignedAt: number
  startedAt?: number
  timeoutMs: number
  originalTimeoutMs: number
  reloadRecorded?: boolean
}

interface ConsumerInfo {
  consumerId: string
  platform: string
  registeredAt: number
  lastSeen: number
  testsCompleted: number
  testsRunning: number
  bootstrapped?: boolean
}

interface ProfilingSnapshot {
  profilerExport: ProfilerExport
  kind: 'checkpoint' | 'final'
  sequence?: number
  timestamp: string
  receivedAt: number
}

// Test result type imported from schemas
type TestResult = MqttTestResult

// Safety timeout for crashed consumers (normal path: all consumers publish on batch-complete)
const PROFILING_SAFETY_TIMEOUT_MS = 10000
const TIMEOUT_CHECK_INTERVAL_MS = 10000
const TIMEOUT_GRACE_MS = TIMEOUT_CHECK_INTERVAL_MS + 5000

export class BatchOrchestrator {
  private client: MqttClient
  private runId: string
  private allowWildcardConsumers: boolean
  private consumerTimeoutSec: number
  private consumerInactivityTimeoutMs: number
  private reportDir?: string
  private timelinePath?: string
  private appMemPath?: string
  private testQueue: TestCase[] = []
  private assignedTests = new Map<string, TestAssignment>() // uniqueTestId -> assignment
  private completedTests = new Map<string, TestResult>() // uniqueTestId -> result
  private consumers = new Map<string, ConsumerInfo>() // consumerId -> info
  private queueConsumerId?: string
  private profilingData = new Map<string, ProfilingSnapshot>() // consumerId -> latest profiler snapshot
  private finalProfilingConsumers = new Set<string>()
  private testSuites = new Map<string, string[]>() // testId -> suites
  private testCategories = new Map<string, string>() // testId -> metadata.category
  // Unique post-filter testIds, snapshotted in buildTestQueue and replayed
  // in every register-ack so late-joining/reconnecting consumers see a
  // stable set even after testQueue starts shrinking.
  private filteredTestIds: string[] = []
  private initialTotalTests = 0
  private startTime = 0
  private batchStarted = false
  private allConsumersDead = false
  private shutdownTimer?: NodeJS.Timeout
  private consumerTimeoutTimer?: NodeJS.Timeout

  constructor(
    client: MqttClient,
    runId: string,
    allowWildcardConsumers: boolean = false,
    consumerTimeoutSec: number = 30,
    consumerInactivityTimeoutSec: number = 120,
    reportDir?: string
  ) {
    this.client = client
    this.runId = runId
    this.allowWildcardConsumers = allowWildcardConsumers
    this.consumerTimeoutSec = consumerTimeoutSec
    this.consumerInactivityTimeoutMs = consumerInactivityTimeoutSec * 1000
    this.reportDir = reportDir
    if (reportDir) {
      try {
        fs.mkdirSync(reportDir, { recursive: true })
      } catch {}
      this.timelinePath = path.join(reportDir, 'test-timeline.ndjson')
      this.appMemPath = path.join(reportDir, 'app-mem.ndjson')
    }
    this.setupMqttHandlers()
  }

  private handleAppMemorySample(rawMessage: unknown): void {
    if (!this.appMemPath) return
    if (!rawMessage || typeof rawMessage !== 'object') return
    const m = rawMessage as Record<string, unknown>
    // Validate the minimum shape; ignore obviously broken entries.
    if (typeof m.ts !== 'number' || typeof m.memoryKb !== 'number') return
    if (typeof m.platform !== 'string') return
    // unit/limitKb/peakKb are passed through for extended memory series
    // (/proc-derived Android values and task_vm_info-derived iOS values). Older
    // publishers omit them; default to the resident-memory shape (kb, no
    // ceiling).
    const unit = m.unit === 'count' ? 'count' : 'kb'
    const record = {
      ts: m.ts,
      pid: typeof m.pid === 'number' ? m.pid : null,
      memoryKb: m.memoryKb,
      peakKb: typeof m.peakKb === 'number' ? m.peakKb : null,
      limitKb: typeof m.limitKb === 'number' ? m.limitKb : null,
      metric: typeof m.metric === 'string' ? m.metric : 'in-app',
      unit,
      platform: m.platform,
      consumerId: typeof m.consumerId === 'string' ? m.consumerId : undefined
    }
    try {
      fs.appendFileSync(this.appMemPath, JSON.stringify(record) + '\n')
    } catch {
      // Non-fatal: app memory ndjson is auxiliary.
    }
  }

  private appendTimeline(event: {
    ts: number
    consumerId: string
    testId: string
    uniqueTestId: string
    phase: 'start' | 'end' | 'reload'
  }): void {
    if (!this.timelinePath) return
    try {
      fs.appendFileSync(this.timelinePath, JSON.stringify(event) + '\n')
    } catch {
      // non-fatal: timeline is auxiliary
    }
  }

  private setupMqttHandlers() {
    this.client.on('connect', () => {
      console.log('✅ Producer connected to MQTT broker')
      console.log(`🔑 Run ID: ${this.runId}`)
      console.log(`🌐 Wildcard consumers: ${this.allowWildcardConsumers ? 'allowed' : 'disabled'}`)

      // Subscribe to all coordination topics
      this.client.subscribe(
        [
          'qvac/register',
          'qvac/test-prepare',
          'qvac/test-start',
          'qvac/test-reload',
          'qvac/results',
          'qvac/heartbeat',
          'qvac/queue-empty',
          'qvac/profiling',
          'qvac/app-memory'
        ],
        { qos: 1 },
        (err) => {
          if (err) {
            console.error('❌ Failed to subscribe:', err)
            process.exit(1)
          }
          console.log('📡 Subscribed to coordination topics')
        }
      )
    })

    this.client.on('message', (topic, payload) => {
      try {
        const message = JSON.parse(payload.toString())

        const isWildcardConsumer = message.runId === '*'
        const isMatchingRunId = message.runId === this.runId

        if (!isMatchingRunId && !(isWildcardConsumer && this.allowWildcardConsumers)) {
          return
        }

        switch (topic) {
          case 'qvac/register':
            this.handleConsumerRegistration(message)
            break
          case 'qvac/test-prepare':
            this.handleTestPrepare(message)
            break
          case 'qvac/test-start':
            this.handleTestStart(message)
            break
          case 'qvac/test-reload':
            this.handleTestReload(message)
            break
          case 'qvac/results':
            this.handleTestResult(message)
            break
          case 'qvac/heartbeat':
            this.handleHeartbeat(message)
            break
          case 'qvac/queue-empty':
            this.handleQueueEmpty(message)
            break
          case 'qvac/profiling':
            this.handleProfilingData(message)
            break
          case 'qvac/app-memory':
            this.handleAppMemorySample(message)
            break
        }
      } catch (error) {
        console.error(`❌ Error handling ${topic}:`, error)
      }
    })

    this.client.on('reconnect', () => {
      console.log('🔄 Producer reconnecting to MQTT broker...')
    })

    this.client.on('offline', () => {
      console.log('📴 Producer offline')
    })

    this.client.on('close', () => {
      console.log('🔌 Producer MQTT connection closed')
    })

    this.client.on('error', (err) => {
      console.error('❌ MQTT error:', err)
    })
  }

  private handleConsumerRegistration(rawMessage: unknown) {
    const message = consumerRegistrationSchema.parse(rawMessage)
    const { consumerId, platform } = message
    const now = Date.now()

    const existing = this.consumers.get(consumerId)
    if (existing) {
      existing.lastSeen = now
      // Always re-send ack (consumer may not have received it yet)
      this.publishRegistrationAck(existing)
      return
    }

    const consumer: ConsumerInfo = {
      consumerId,
      platform,
      registeredAt: now,
      lastSeen: now,
      testsCompleted: 0,
      testsRunning: 0
    }
    if (this.queueConsumerId) {
      console.warn(`⚠️  Additional consumer ${consumerId} will not receive the active run queue`)
      this.publishRegistrationAck(consumer)
      return
    }

    // Cancel consumer timeout on first registration
    if (this.consumers.size === 0 && this.consumerTimeoutTimer) {
      clearTimeout(this.consumerTimeoutTimer)
      this.consumerTimeoutTimer = undefined
    }

    this.consumers.set(consumerId, consumer)
    this.queueConsumerId = consumerId

    console.log(`\n🔌 Consumer registered: ${consumerId} (${platform})`)
    this.displayStatus()

    // Send acknowledgment with initial total (not current queue length, which shrinks as tests are assigned)
    // filteredTestIds lets the consumer scope its bootstrap to only the deps these tests will hit.
    this.publishRegistrationAck(consumer)
  }

  private publishRegistrationAck(consumer: ConsumerInfo) {
    const queue =
      consumer.consumerId === this.queueConsumerId
        ? this.testQueue.map(({ id, testId }) => ({ uniqueTestId: id, testId }))
        : []
    this.client.publish(
      `qvac/register-ack/${consumer.consumerId}`,
      JSON.stringify({
        runId: this.runId,
        status: 'registered',
        totalTests: this.initialTotalTests,
        queue,
        filteredTestIds: this.filteredTestIds
      }),
      { qos: 1 }
    )
  }

  private handleTestPrepare(rawMessage: unknown) {
    const message = testPrepareSchema.parse(rawMessage)
    const { consumerId, uniqueTestId } = message
    const consumer = this.consumers.get(consumerId)

    if (!consumer || consumerId !== this.queueConsumerId) {
      console.warn(`⚠️  Test prepare from unregistered consumer: ${consumerId}`)
      return
    }

    consumer.lastSeen = Date.now()
    const timelineTs = Date.parse(message.timestamp)
    this.prepareTest(
      consumerId,
      uniqueTestId,
      Number.isFinite(timelineTs) ? timelineTs : Date.now()
    )
  }

  private prepareTest(consumerId: string, uniqueTestId: string, timelineTs: number) {
    const existing = this.assignedTests.get(uniqueTestId)
    if (existing || this.completedTests.has(uniqueTestId)) {
      return existing
    }
    const consumer = this.consumers.get(consumerId)
    const nextTest = this.testQueue.find((test) => test.id === uniqueTestId)
    if (!consumer || consumerId !== this.queueConsumerId || !nextTest) {
      console.warn(`⚠️  Test prepare for unknown test: ${uniqueTestId}`)
      return
    }

    const assignment: TestAssignment = {
      testCase: nextTest,
      consumerId,
      assignedAt: Date.now(),
      // 3x estimate min 180s: accounts for setup phase (model loading) + test + buffer
      timeoutMs: Math.max(nextTest.estimatedDurationMs * 3, 180000),
      originalTimeoutMs: Math.max(nextTest.estimatedDurationMs * 3, 180000)
    }

    this.assignedTests.set(nextTest.id, assignment)
    consumer.testsRunning++

    // Remove from queue
    this.testQueue = this.testQueue.filter((t) => t.id !== nextTest.id)

    // Memory timeline `start` fires at assignment time, not when the
    // consumer sends test-start. The window between assignment and
    // consumer-reported start is the setup phase (model loading etc.) --
    // exactly where OOM crashes during model load happen, and where we
    // most want to attribute memory usage to the test responsible.
    this.appendTimeline({
      ts: timelineTs,
      consumerId,
      testId: nextTest.testId,
      uniqueTestId: nextTest.id,
      phase: 'start'
    })

    console.log(`📥 Consumer prepared ${nextTest.testId} (${nextTest.id})`)
    this.displayStatus()
    return assignment
  }

  private handleQueueEmpty(rawMessage: unknown) {
    const message = queueEmptySchema.parse(rawMessage)
    if (message.consumerId !== this.queueConsumerId || !this.consumers.has(message.consumerId)) {
      return
    }
    this.checkBatchComplete()
  }

  private handleTestStart(rawMessage: unknown) {
    const message = testStartSchema.parse(rawMessage)
    const { consumerId, uniqueTestId } = message
    const startTs = Date.parse(message.timestamp)
    const assignment =
      this.assignedTests.get(uniqueTestId) ??
      this.prepareTest(consumerId, uniqueTestId, Number.isFinite(startTs) ? startTs : Date.now())

    if (!assignment) {
      console.warn(`⚠️  Test start for unknown test: ${uniqueTestId}`)
      return
    }

    assignment.startedAt = Date.now()
    console.log(`▶️  Test ${assignment.testCase.testId} started by ${consumerId}`)
  }

  private handleTestReload(rawMessage: unknown) {
    const message = testReloadSchema.parse(rawMessage)
    const { consumerId, uniqueTestId, testId, ts } = message

    const assignment =
      this.assignedTests.get(uniqueTestId) ??
      this.prepareTest(consumerId, uniqueTestId, Number.isFinite(ts) ? ts : Date.now())

    if (!assignment) {
      console.warn(`⚠️  Reload boundary for unknown/timed-out test: ${uniqueTestId}`)
      return
    }

    if (!assignment.reloadRecorded) {
      assignment.reloadRecorded = true
      const elapsed = Date.now() - assignment.assignedAt
      assignment.timeoutMs = elapsed + 2 * assignment.originalTimeoutMs

      const producerTs = Date.now()
      this.appendTimeline({
        ts: producerTs,
        consumerId,
        testId,
        uniqueTestId,
        phase: 'reload'
      })
      const skewMs = producerTs - ts
      console.log(
        `🔄 Test ${testId} reload boundary (${uniqueTestId}) from ${consumerId} (consumer skew: ${skewMs}ms)`
      )
    } else {
      console.log(`⚠️  Ignoring duplicate reload boundary for ${uniqueTestId} (QoS-1 redelivery)`)
    }
  }

  private handleTestResult(rawMessage: unknown) {
    const message = testResultSchema.parse(rawMessage)
    const { consumerId, uniqueTestId, outcome, duration } = message
    const resultTs = Date.parse(message.timestamp)
    const assignment =
      this.assignedTests.get(uniqueTestId) ??
      this.prepareTest(
        consumerId,
        uniqueTestId,
        Number.isFinite(resultTs) ? resultTs - duration : Date.now()
      )

    if (!assignment) {
      console.warn(`⚠️  Result for unknown test: ${uniqueTestId}`)
      return
    }

    // Update consumer stats
    const consumer = this.consumers.get(consumerId)
    if (consumer) {
      consumer.testsCompleted++
      consumer.testsRunning--
      consumer.lastSeen = Date.now()
    }

    if (message.retried && !assignment.reloadRecorded) {
      assignment.reloadRecorded = true
      const baseTs = assignment.startedAt ?? assignment.assignedAt
      const attempt1DurationMs =
        typeof message.attempt1DurationMs === 'number'
          ? Math.max(0, Math.floor(message.attempt1DurationMs))
          : 0
      const syntheticReloadTs = baseTs + attempt1DurationMs
      this.appendTimeline({
        ts: syntheticReloadTs,
        consumerId,
        testId: assignment.testCase.testId,
        uniqueTestId,
        phase: 'reload'
      })
      console.log(
        `⚠️  Synthetic reload boundary for ${assignment.testCase.testId} (results arrived before reload event)`
      )
    }

    // Store result
    this.completedTests.set(uniqueTestId, message)
    this.assignedTests.delete(uniqueTestId)

    this.appendTimeline({
      ts: Date.now(),
      consumerId,
      testId: assignment.testCase.testId,
      uniqueTestId,
      phase: 'end'
    })

    const statusIcon = outcome === 'skipped' ? '⏭️' : outcome === 'success' ? '✅' : '❌'
    console.log(
      `${statusIcon} Test ${assignment.testCase.testId} ${outcome} (${duration}ms) - ${consumerId}`
    )

    if (message.error) {
      // Show full error, but split long errors into multiple lines
      const errorLines = message.error.split('\n')
      if (errorLines.length > 5) {
        console.log(`   Error: ${errorLines.slice(0, 5).join('\n   ')}`)
        console.log(`   ... (${errorLines.length - 5} more lines)`)
      } else {
        console.log(`   Error: ${message.error}`)
      }
    }

    this.displayStatus()
    this.checkBatchComplete()
  }

  private handleHeartbeat(rawMessage: unknown) {
    const message = heartbeatSchema.parse(rawMessage)
    const { consumerId } = message
    const consumer = this.consumers.get(consumerId)
    if (consumer) {
      consumer.lastSeen = Date.now()
      consumer.bootstrapped = message.bootstrapped
    }
  }

  private handleProfilingData(rawMessage: unknown) {
    const message = profilingDataSchema.parse(rawMessage)
    const { consumerId, profilerExport } = message

    if (!this.consumers.has(consumerId)) {
      console.log(
        `⚠️  Ignoring profiling from unknown consumer: ${consumerId.split('-').slice(1, 3).join('-')}`
      )
      return
    }

    const kind = message.kind ?? 'final'
    const existing = this.profilingData.get(consumerId)

    // Guards run BEFORE the .set() so a late checkpoint can never overwrite the
    // final snapshot: forceShutdown force-publishes a checkpoint (with a higher
    // sequence) after finalize already published final, and QoS-1 reconnects can
    // reorder delivery. lastSeen is still bumped below regardless of the guards.
    const consumer = this.consumers.get(consumerId)
    if (consumer) {
      consumer.lastSeen = Date.now()
    }

    // Never downgrade a final snapshot to a checkpoint.
    if (kind === 'checkpoint' && existing?.kind === 'final') {
      return
    }
    // Drop out-of-order checkpoints. Skipped when either sequence is undefined so
    // older publishers keep last-write-wins and never lose data.
    if (
      kind === 'checkpoint' &&
      existing &&
      message.sequence !== undefined &&
      existing.sequence !== undefined &&
      message.sequence <= existing.sequence
    ) {
      return
    }

    this.profilingData.set(consumerId, {
      profilerExport,
      kind,
      sequence: message.sequence,
      timestamp: message.timestamp,
      receivedAt: Date.now()
    })
    if (kind === 'final') {
      this.finalProfilingConsumers.add(consumerId)
    }

    const metricCount = getMetricCount(profilerExport)
    const metricLabel = metricCount !== undefined ? `${metricCount} metrics` : 'N/A'
    console.log(
      `📈 Received ${kind} profiling data from ${consumerId.split('-').slice(1, 3).join('-')} (${metricLabel})`
    )
  }

  private checkBatchComplete() {
    const queueEmpty = this.testQueue.length === 0
    const noAssignedTests = this.assignedTests.size === 0

    if (queueEmpty && noAssignedTests) {
      this.completeBatch()
    }
  }

  private checkTimeouts() {
    const now = Date.now()
    const timeouts: string[] = []

    for (const [uniqueTestId, assignment] of this.assignedTests) {
      const elapsed = now - assignment.assignedAt
      if (elapsed > assignment.timeoutMs + TIMEOUT_GRACE_MS) {
        timeouts.push(uniqueTestId)
      }
    }

    if (timeouts.length > 0) {
      console.log(`\n⏱️  ${timeouts.length} test(s) timed out:`)
      for (const uniqueTestId of timeouts) {
        const assignment = this.assignedTests.get(uniqueTestId)
        if (assignment) {
          console.log(`   - ${assignment.testCase.testId} (${assignment.consumerId})`)

          // Create timeout result
          const timeoutResult: TestResult = {
            runId: this.runId,
            consumerId: assignment.consumerId,
            testId: assignment.testCase.testId,
            uniqueTestId,
            outcome: 'failure',
            duration: Date.now() - assignment.assignedAt,
            timestamp: new Date().toISOString(),
            error: `Test timed out after ${assignment.timeoutMs}ms`
          }

          this.completedTests.set(uniqueTestId, timeoutResult)
          this.assignedTests.delete(uniqueTestId)

          // Update consumer stats
          const consumer = this.consumers.get(assignment.consumerId)
          if (consumer) {
            consumer.testsRunning--
          }
        }
      }

      this.checkBatchComplete()
    }

    // Check consumer liveness (heartbeat-based)
    const deadConsumers: string[] = []
    for (const [consumerId, consumer] of this.consumers) {
      const silent = now - consumer.lastSeen
      if (silent > this.consumerInactivityTimeoutMs) {
        deadConsumers.push(consumerId)
      }
    }

    for (const consumerId of deadConsumers) {
      const silent = now - (this.consumers.get(consumerId)?.lastSeen ?? 0)
      console.error(
        `\n💀 Consumer ${consumerId.split('-').slice(1, 3).join('-')} unresponsive for ${Math.round(silent / 1000)}s — marking as dead`
      )

      for (const [uniqueTestId, assignment] of this.assignedTests) {
        if (assignment.consumerId === consumerId) {
          const failResult: TestResult = {
            runId: this.runId,
            consumerId,
            testId: assignment.testCase.testId,
            uniqueTestId,
            outcome: 'failure',
            duration: Date.now() - assignment.assignedAt,
            timestamp: new Date().toISOString(),
            error: `Consumer became unresponsive (no heartbeat for ${Math.round(silent / 1000)}s)`
          }
          this.completedTests.set(uniqueTestId, failResult)
          this.assignedTests.delete(uniqueTestId)
        }
      }

      this.consumers.delete(consumerId)
    }

    if (deadConsumers.length > 0) {
      if (this.consumers.size === 0 && (this.testQueue.length > 0 || this.assignedTests.size > 0)) {
        console.error('\n❌ All consumers are dead. Terminating batch.')
        this.allConsumersDead = true

        // Fail all remaining queued tests
        while (this.testQueue.length > 0) {
          const testCase = this.testQueue.shift()!
          const uniqueTestId = `${testCase.testId}-orphaned`
          const failResult: TestResult = {
            runId: this.runId,
            consumerId: 'none',
            testId: testCase.testId,
            uniqueTestId,
            outcome: 'failure',
            duration: 0,
            timestamp: new Date().toISOString(),
            error: 'Consumer died before test could be executed'
          }
          this.completedTests.set(uniqueTestId, failResult)
        }

        this.completeBatch()
      } else {
        this.checkBatchComplete()
      }
    }
  }

  private displayStatus() {
    const total = this.testQueue.length + this.assignedTests.size + this.completedTests.size
    const completed = this.completedTests.size
    const running = this.assignedTests.size
    const queued = this.testQueue.length
    const consumers = this.consumers.size
    const elapsed =
      this.startTime > 0 ? `${Math.round((Date.now() - this.startTime) / 1000)}s` : '0s'

    console.log(
      `\n📊 Status [${elapsed}]: ${completed}/${total} completed | ${running} running | ${queued} queued | ${consumers} consumers`
    )

    if (running > 0) {
      const now = Date.now()
      for (const assignment of this.assignedTests.values()) {
        const waitSec = Math.round((now - (assignment.startedAt ?? assignment.assignedAt)) / 1000)
        const timeoutSec = Math.round(assignment.timeoutMs / 1000)
        const phase = assignment.startedAt ? 'running' : 'setup'
        console.log(
          `   ⏳ ${assignment.testCase.testId} → ${assignment.consumerId} (${phase}, ${waitSec}s / ${timeoutSec}s)`
        )
      }
    }
    if (this.consumers.size > 0) {
      const consumerStates = Array.from(this.consumers.values())
        .map((c) => `${c.consumerId} <bootstrapped=${c.bootstrapped ?? false}>`)
        .join(', ')
      console.log(`   🫀 ${consumerStates}`)
    }
    console.log()
  }

  private completeBatch() {
    if (this.shutdownTimer) return // Already shutting down

    const duration = this.startTime > 0 ? Date.now() - this.startTime : 0
    const totalTests = this.completedTests.size
    const results = Array.from(this.completedTests.values())
    const successCount = results.filter((r) => r.outcome === 'success').length
    const skippedCount = results.filter((r) => r.outcome === 'skipped').length
    const failureCount = results.filter((r) => r.outcome === 'failure').length

    console.log(`\n${'='.repeat(80)}`)
    console.log('🎉 BATCH COMPLETE')
    console.log('='.repeat(80))
    console.log(`⏱️  Total Duration: ${(duration / 1000).toFixed(2)}s`)
    console.log(`📝 Total Tests: ${totalTests}`)
    console.log(`✅ Passed: ${successCount}`)
    console.log(`⏭️  Skipped: ${skippedCount}`)
    console.log(`❌ Failed: ${failureCount}`)
    console.log(
      `📈 Success Rate: ${((successCount / Math.max(totalTests - skippedCount, 1)) * 100).toFixed(1)}%`
    )
    console.log('\n👥 Consumer Stats:')

    for (const consumer of this.consumers.values()) {
      console.log(
        `   - ${consumer.consumerId} (${consumer.platform}): ${consumer.testsCompleted} tests`
      )
    }

    console.log('\n📋 Test Results by Category:\n')
    this.displayResultsByCategory()
    this.displayResultsBySuite()

    console.log(`\n📨 Signaling ${this.consumers.size} consumer(s) to complete...`)
    this.client.publish(
      'qvac/batch-complete',
      JSON.stringify({
        runId: this.runId,
        status: 'complete',
        totalTests,
        successCount,
        failureCount,
        skippedCount,
        duration
      }),
      { qos: 1 }
    )

    const expectedIds = new Set(this.consumers.keys())
    this.waitForProfilingData(expectedIds)
  }

  private waitForProfilingData(expectedIds: Set<string>) {
    if (expectedIds.size === 0) {
      return this.finishAfterProfiling(false, [])
    }

    const startTime = Date.now()
    const timer = setInterval(() => {
      const pending = [...expectedIds].filter((id) => !this.finalProfilingConsumers.has(id))
      const timedOut = Date.now() - startTime >= PROFILING_SAFETY_TIMEOUT_MS

      if (pending.length === 0 || timedOut) {
        clearInterval(timer)
        this.finishAfterProfiling(timedOut, pending)
      }
    }, 100)
  }

  private finishAfterProfiling(timedOut: boolean, pendingIds: string[]) {
    if (timedOut && pendingIds.length > 0) {
      const pendingShort = pendingIds.map((id) => id.split('-').slice(1, 3).join('-'))
      console.log(
        `⚠️  Safety timeout: missing profiling from ${pendingIds.length} consumer(s): ${pendingShort.join(', ')}`
      )
    } else {
      const receivedCount = this.finalProfilingConsumers.size
      if (receivedCount > 0) {
        console.log(`✅ Received profiling data from all ${receivedCount} consumer(s)`)
      }
    }
    this.generateReports()
    this.scheduleShutdown()
  }

  private generateReports() {
    try {
      const profilingDataArray: ReportProfilingData[] = Array.from(
        this.profilingData.entries()
      ).map(([consumerId, snapshot]) => ({
        consumerId,
        profilerExport: snapshot.profilerExport,
        kind: snapshot.kind,
        sequence: snapshot.sequence,
        timestamp: snapshot.timestamp,
        receivedAt: snapshot.receivedAt,
        incomplete: snapshot.kind !== 'final'
      }))

      const completedTests = Array.from(this.completedTests.values()).map((result) => ({
        ...result,
        suites: this.testSuites.get(result.testId),
        category: this.testCategories.get(result.testId)
      }))

      let memorySummaries: MemorySummary[] = []
      let memNdjsonPath: string | undefined
      if (this.reportDir) {
        memNdjsonPath = this.appMemPath
        try {
          memorySummaries = aggregateMemory(this.reportDir)
        } catch (e) {
          console.warn(`⚠️  Failed to aggregate memory data: ${(e as Error).message}`)
        }
      }

      const reportData: ReportData = {
        runId: this.runId,
        completedTests,
        consumers: this.consumers,
        startTime: this.startTime,
        profilingData: profilingDataArray.length > 0 ? profilingDataArray : undefined,
        memorySummaries: memorySummaries.length > 0 ? memorySummaries : undefined,
        reportDir: this.reportDir
      }

      const htmlPath = generateHtmlReport(reportData)
      const jsonPath = generateJsonReport(reportData)

      console.log(`\n📄 Reports generated:`)
      console.log(`   HTML: ${htmlPath}`)
      console.log(`   JSON: ${jsonPath}`)
      if (profilingDataArray.length > 0) {
        console.log(`📈 Profiling data included from ${profilingDataArray.length} consumer(s)`)
      }
      if (memorySummaries.length > 0) {
        const primary = memorySummaries[0]
        const peak =
          primary.unit === 'count'
            ? `${primary.peakSuite.memoryKb} ${primary.metric}`
            : `${(primary.peakSuite.memoryKb / 1024).toFixed(1)} MB`
        const series = memorySummaries.map((s) => `${s.metric} (${s.chart.length})`).join(', ')
        console.log(
          `📉 Memory: ${memorySummaries.length} series [${series}] — peak ${peak} — ${memNdjsonPath}`
        )
      } else if (memNdjsonPath) {
        // Diagnostic: explain why the memory tab is missing.
        let reason = 'no samples captured'
        try {
          if (!fs.existsSync(memNdjsonPath)) reason = `${memNdjsonPath} not found`
          else if (fs.statSync(memNdjsonPath).size === 0) reason = `${memNdjsonPath} is empty`
        } catch {}
        console.log(`📉 Memory: skipped (${reason})`)
      }
    } catch (error) {
      console.error('\n⚠️  Failed to generate reports:', error)
    }
  }

  private scheduleShutdown() {
    const exitCode = this.allConsumersDead ? 1 : 0
    this.shutdownTimer = setTimeout(() => {
      console.log('\n👋 Shutting down producer...\n')
      this.client.end(false, buildMqttSessionEndOptions(this.client.options.protocolVersion), () =>
        process.exit(exitCode)
      )
    }, 2000)
  }

  private displayResultsByCategory() {
    const categories = new Map<string, { passed: number; failed: number; skipped: number }>()

    for (const result of this.completedTests.values()) {
      // Prefer the test's declared metadata.category over deriving from
      // testId — splitting "wrong-model-..." would otherwise bucket it
      // as "wrong" instead of "wrong-model".
      const category =
        this.testCategories.get(result.testId) ??
        (result.testId.includes('-') ? result.testId.split('-')[0] : result.testId)

      if (!categories.has(category)) {
        categories.set(category, { passed: 0, failed: 0, skipped: 0 })
      }

      const stats = categories.get(category)!
      if (result.outcome === 'success') {
        stats.passed++
      } else if (result.outcome === 'skipped') {
        stats.skipped++
      } else {
        stats.failed++
      }
    }

    for (const [category, stats] of categories) {
      const total = stats.passed + stats.failed + stats.skipped
      const rate = ((stats.passed / Math.max(total - stats.skipped, 1)) * 100).toFixed(0)
      const skipStr = stats.skipped > 0 ? `, ${stats.skipped} skipped` : ''
      console.log(`   ${category.padEnd(20)} ${stats.passed}/${total} (${rate}%${skipStr})`)
    }
  }

  private displayResultsBySuite() {
    if (this.testSuites.size === 0) return

    const suites = new Map<string, { passed: number; failed: number; skipped: number }>()

    for (const [, result] of this.completedTests) {
      const testSuiteList = this.testSuites.get(result.testId)
      if (!testSuiteList) continue

      for (const suite of testSuiteList) {
        if (!suites.has(suite)) {
          suites.set(suite, { passed: 0, failed: 0, skipped: 0 })
        }
        const stats = suites.get(suite)!
        if (result.outcome === 'success') {
          stats.passed++
        } else if (result.outcome === 'skipped') {
          stats.skipped++
        } else {
          stats.failed++
        }
      }
    }

    if (suites.size === 0) return

    console.log('\n📋 Test Results by Suite:\n')
    for (const [suite, stats] of suites) {
      const total = stats.passed + stats.failed + stats.skipped
      const rate = ((stats.passed / Math.max(total - stats.skipped, 1)) * 100).toFixed(0)
      const skipStr = stats.skipped > 0 ? `, ${stats.skipped} skipped` : ''
      console.log(`   ${suite.padEnd(20)} ${stats.passed}/${total} (${rate}%${skipStr})`)
    }
  }

  public buildTestQueue(tests: TestDefinition[]) {
    console.log('🔨 Building test queue...\n')

    let counter = 0
    let skippedCount = 0

    for (const test of tests) {
      if (test.skip && !test.skip.platforms) {
        skippedCount++
        console.log(
          `⏭️  Skipping ${test.testId}: ${test.skip.reason}${test.skip.issue ? ` (${test.skip.issue})` : ''}`
        )

        // Record as skipped result so it appears in reports
        const skipId = `skip-${Date.now()}-${counter++}`
        this.completedTests.set(skipId, {
          runId: this.runId,
          consumerId: 'producer',
          testId: test.testId,
          uniqueTestId: skipId,
          outcome: 'skipped',
          duration: 0,
          timestamp: new Date().toISOString(),
          error: `${test.skip.reason}${test.skip.issue ? ` (${test.skip.issue})` : ''}`
        })
        if (typeof test.metadata?.category === 'string' && test.metadata.category.length > 0) {
          this.testCategories.set(test.testId, test.metadata.category)
        }
        continue
      }

      const testCase: TestCase = {
        id: `test-${Date.now()}-${counter++}`,
        testId: test.testId,
        metadata: test.metadata || {},
        suites: test.suites,
        estimatedDurationMs: test.metadata?.estimatedDurationMs || 10000
      }
      if (test.suites) {
        this.testSuites.set(test.testId, test.suites)
      }
      if (typeof test.metadata?.category === 'string' && test.metadata.category.length > 0) {
        this.testCategories.set(test.testId, test.metadata.category)
      }
      this.testQueue.push(testCase)
    }

    if (skippedCount > 0) {
      console.log(`\n⏭️  Skipped ${skippedCount} tests\n`)
    }

    // Group by category from metadata for reporting
    const byCategory = new Map<string, number>()
    for (const test of this.testQueue) {
      const category =
        (typeof test.metadata?.category === 'string' ? test.metadata.category : null) ||
        'uncategorized'
      byCategory.set(category, (byCategory.get(category) || 0) + 1)
    }

    this.initialTotalTests = this.testQueue.length + this.completedTests.size
    // Dedupe N-iteration tests; consumers only need each testId once.
    this.filteredTestIds = Array.from(new Set(this.testQueue.map((t) => t.testId)))

    console.log(`📦 Built ${this.testQueue.length} tests:`)
    for (const [category, count] of byCategory) {
      console.log(`   - ${category}: ${count} tests`)
    }
    console.log()
  }

  public start() {
    if (this.batchStarted) {
      console.warn('⚠️  Batch already started')
      return
    }

    this.batchStarted = true
    this.startTime = Date.now()

    console.log('🚀 Batch orchestration started')
    console.log(`📋 Total tests: ${this.testQueue.length}`)
    console.log(`⏳ Waiting for consumers to register (timeout: ${this.consumerTimeoutSec}s)...\n`)

    // Start consumer connection timeout
    this.consumerTimeoutTimer = setTimeout(() => {
      if (this.consumers.size === 0) {
        console.error(`\n❌ No consumers connected within ${this.consumerTimeoutSec}s timeout`)
        console.error('   Make sure the consumer is running with the same --runId')
        this.client.end(
          false,
          buildMqttSessionEndOptions(this.client.options.protocolVersion),
          () => process.exit(1)
        )
      }
    }, this.consumerTimeoutSec * 1000)

    // Start timeout checker (every 10 seconds)
    setInterval(() => this.checkTimeouts(), TIMEOUT_CHECK_INTERVAL_MS)

    // Display status every 30 seconds
    setInterval(() => {
      if (this.assignedTests.size > 0 || this.testQueue.length > 0) {
        this.displayStatus()
      }
    }, 30000)
  }

  public shutdown() {
    console.log('\n⚠️  Shutting down...')
    this.client.end(false, buildMqttSessionEndOptions(this.client.options.protocolVersion), () =>
      process.exit(0)
    )
  }
}

// Export for use as library
// Main execution removed - will be handled by CLI
