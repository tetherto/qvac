import type { MqttClient } from "mqtt";
import type { TestExecutor } from "./types";

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

export interface ConsumerCallbacks {
	log: (message: string) => void;
	updateStats: (update: {
		testsCompleted?: number;
		testsPassed?: number;
		testsFailed?: number;
		totalTests?: number;
		currentTest?: string;
		isComplete?: boolean;
	}) => void;
	onShutdown?: () => void;
}

export abstract class ConsumerBase {
	protected client: MqttClient;
	protected consumerId: string;
	protected platform: string;
	protected runId: string;
	protected isWildcard: boolean;
	protected llmModelId: string | null = null;
	protected whisperModelId: string | null = null;
	protected embeddingModelId: string | null = null;
	protected translationModelId: string | null = null;
	protected nmtModelId: string | null = null;
	protected toolsModelId: string | null = null;
	protected visionModelId: string | null = null;
	protected ttsModelId: string | null = null;
	protected executor: any; // TestExecutor type
	protected registered = false;
	protected testsCompleted = 0;
	protected testsPassed = 0;
	protected testsFailed = 0;
	protected isProcessingTest = false;
	protected shutdownRequested = false;
	protected callbacks: ConsumerCallbacks;

	constructor(
		client: MqttClient,
		consumerId: string,
		platform: string,
		runId: string,
		executor: any,
		callbacks: ConsumerCallbacks
	) {
		this.client = client;
		this.consumerId = consumerId;
		this.platform = platform;
		this.runId = runId;
		this.isWildcard = runId === '*';
		this.executor = executor;
		this.callbacks = callbacks;
	}

	protected log(message: string) {
		this.callbacks.log(message);
	}

	protected updateStats(update: Parameters<ConsumerCallbacks['updateStats']>[0]) {
		this.callbacks.updateStats(update);
	}

	/**
	 * Get platform-specific eSpeak-ng-data path
	 * First checks ESPEAK_DATA_PATH environment variable, then falls back to platform defaults
	 */
	protected getESpeakDataPath(): string {
		// Check environment variable first
		if (process.env.ESPEAK_DATA_PATH) {
			return process.env.ESPEAK_DATA_PATH;
		}

		// Platform-specific default paths
		const platform = process.platform;
		const arch = process.arch;
		
		if (platform === 'win32') {
			// Windows
			return 'C:/Program Files/eSpeak NG/espeak-ng-data';
		} else if (platform === 'darwin') {
			// macOS - different paths for Intel vs Apple Silicon
			if (arch === 'arm64') {
				return '/opt/homebrew/share/espeak-ng-data'; // Apple Silicon (M1/M2/M3)
			} else {
				return '/usr/local/share/espeak-ng-data'; // Intel Mac
			}
		} else if (platform === 'linux') {
			// Linux
			return '/usr/share/espeak-ng-data';
		} else if (platform === 'android') {
			// Android - app-specific path (adjust package name as needed)
			return '/data/data/com.tetherto.qvac/files/espeak-ng-data';
		} else {
			// iOS or unknown - fallback to relative path (iOS resolves from app bundle)
			return 'espeak-ng-data';
		}
	}

	// Abstract methods that platforms must implement
	protected abstract loadLlmModel(): Promise<string>;
	protected abstract loadWhisperModel(): Promise<string>;
	protected abstract loadEmbeddingModel(): Promise<string>;
	protected abstract loadToolsModel(): Promise<string>;
	protected abstract loadVisionModel(): Promise<string>;
	protected abstract loadTtsModel(): Promise<string>;
	protected abstract loadNmtModel(): Promise<string>;

	// Determine which model type a test needs
	protected getRequiredModelType(testId: string): 'llm' | 'whisper' | 'embedding' | 'translation' | 'nmt' | 'tools' | 'vision' | 'tts' | null {
		if (testId.startsWith("transcription") || testId.startsWith("config-reload")) {
			// Config reload tests (QVAC-9409) require Whisper model
			return 'whisper';
		} else if (testId.startsWith("addon-logging-")) {
			// Addon logging tests (QVAC-9206) and SDK logging tests (QVAC-9211)
			if (testId === "addon-logging-llm") return 'llm';
			if (testId === "addon-logging-embed") return 'embedding';
			if (testId === "addon-logging-whisper") return 'whisper';
			if (testId === "addon-logging-tts") return 'tts';
			if (testId === "addon-logging-sdk-server") return 'llm'; // SDK logs need worker running
			return 'llm'; // fallback
		} else if (testId.startsWith("nmt-")) {
			return 'nmt';
		} else if (testId.startsWith("translation")) {
			return 'translation';
		} else if (testId.startsWith("embed") || testId.startsWith("rag-")) {
			return 'embedding';
		} else if (testId.startsWith("tools-")) {
			return 'tools';
		} else if (testId.startsWith("vision-")) {
			return 'vision';
		} else if (testId.startsWith("tts-")) {
			return 'tts';
		} else if (
			testId.startsWith("completion") ||
			testId.startsWith("model-load") ||
			testId.startsWith("model-unload") ||
			testId.startsWith("model-switch") ||
			testId.startsWith("model-reload") ||
			testId.startsWith("sharded-model")
		) {
			// Sharded model tests may need embeddings or llm depending on the model type
			if (testId.includes("backward-compatibility") || testId.includes("load") || testId.includes("detection")) {
				return 'embedding'; // Most sharded model tests use embedding models
			}
			return 'llm';
		} else if (testId.startsWith("cache-")) {
			// Cache tests need SDK worker running, so load LLM model to initialize it
			return 'llm';
		} else if (testId.startsWith("error-") || testId.startsWith("param-")) {
			if (testId.includes("completion") || testId.includes("translation") || testId.includes("malformed")) {
				return 'llm';
			} else if (testId.includes("embedding") || testId.includes("rag")) {
				return 'embedding';
			} else if (testId.includes("transcription")) {
				return 'whisper';
			} else {
				return 'llm';
			}
		}
		return null;
	}

	// Ensure required model is loaded for a test
	protected async ensureModelForTest(testId: string): Promise<string | null> {
		const requiredModelType = this.getRequiredModelType(testId);

		if (requiredModelType === 'llm') {
			if (!this.llmModelId) {
				this.log(`   📦 Loading LLM model...`);
				this.llmModelId = await this.loadLlmModel();
			}
			return this.llmModelId;
		}

		if (requiredModelType === 'embedding') {
			if (!this.embeddingModelId) {
				this.log(`   📦 Loading Embedding model...`);
				this.embeddingModelId = await this.loadEmbeddingModel();
			}
			return this.embeddingModelId;
		}

		if (requiredModelType === 'whisper') {
			if (!this.whisperModelId) {
				this.log(`   📦 Loading Whisper model...`);
				this.whisperModelId = await this.loadWhisperModel();
			}
			return this.whisperModelId;
		}

		if (requiredModelType === 'translation') {
			// Translation uses the LLM model
			if (!this.llmModelId) {
				this.log(`   📦 Loading LLM model for translation...`);
				this.llmModelId = await this.loadLlmModel();
			}
			this.translationModelId = this.llmModelId;
			return this.llmModelId;
		}

		if (requiredModelType === 'nmt') {
			if (!this.nmtModelId) {
				this.log(`   📦 Loading NMT model (Marian/Opus)...`);
				this.nmtModelId = await this.loadNmtModel();
				// Set the NMT model ID in the executor
				if (this.executor.setNmtModelId) {
					this.executor.setNmtModelId(this.nmtModelId);
				}
			}
			return this.nmtModelId;
		}

		if (requiredModelType === 'tools') {
			if (!this.toolsModelId) {
				this.log(`   📦 Loading Tools model (QWEN)...`);
				this.toolsModelId = await this.loadToolsModel();
				// Set the tools model ID in the executor
				if (this.executor.setToolsModelId) {
					this.executor.setToolsModelId(this.toolsModelId);
				}
			}
			return this.toolsModelId;
		}

		if (requiredModelType === 'vision') {
			if (!this.visionModelId) {
				this.log(`   📦 Loading Vision model (SmolVLM2)...`);
				this.visionModelId = await this.loadVisionModel();
				// Set the vision model ID in the executor
				if (this.executor.setVisionModelId) {
					this.executor.setVisionModelId(this.visionModelId);
				}
			}
			return this.visionModelId;
		}

		if (requiredModelType === 'tts') {
			if (!this.ttsModelId) {
				this.log(`   📦 Loading TTS model (Piper)...`);
				this.ttsModelId = await this.loadTtsModel();
				// Set the TTS model ID in the executor
				if (this.executor.setTtsModelId) {
					this.executor.setTtsModelId(this.ttsModelId);
				}
			}
			return this.ttsModelId;
		}

		return null;
	}

	protected requestNextTest() {
		if (!this.registered || this.isProcessingTest || this.shutdownRequested) {
			return;
		}

		this.client.publish(
			"qvac/request-test",
			JSON.stringify({
				runId: this.runId,
				consumerId: this.consumerId,
				timestamp: new Date().toISOString(),
			}),
			{ qos: 1 }
		);
	}

	public setupMqttHandlers() {
		this.client.on("connect", () => {
			this.log("✅ Connected to MQTT broker");
			this.log(`🔑 Run ID: ${this.runId}${this.isWildcard ? ' (wildcard mode)' : ''}`);

			// Subscribe to consumer-specific topics
			this.client.subscribe(
				[
					`qvac/register-ack/${this.consumerId}`,
					`qvac/test-assigned/${this.consumerId}`,
					"qvac/batch-complete",
				],
				{ qos: 1 },
				(err) => {
					if (err) {
						this.log(`❌ Failed to subscribe: ${err.message}`);
						return;
					}
					this.log("📡 Subscribed to topics\n");

					// Register with producer (with retry)
					this.sendRegistration();

					const registrationInterval = setInterval(() => {
						if (!this.registered) {
							this.log(`🔄 Re-sending registration...`);
							this.sendRegistration();
						} else {
							clearInterval(registrationInterval);
						}
					}, 3000);
				}
			);
		});

		this.client.on("message", async (topic, payload) => {
			try {
				const message = JSON.parse(payload.toString());

				if (!this.isWildcard && message.runId !== this.runId) {
					return;
				}

				if (topic === `qvac/register-ack/${this.consumerId}`) {
					this.handleRegistrationAck(message);
				} else if (topic === `qvac/test-assigned/${this.consumerId}`) {
					await this.handleTestAssignment(message);
				} else if (topic === "qvac/batch-complete") {
					this.handleBatchComplete(message);
				}
			} catch (error: any) {
				this.log(`❌ Error handling ${topic}: ${error.message}`);
			}
		});

		this.client.on("error", (err) => {
			this.log(`❌ MQTT error: ${err.message}`);
		});
	}

	protected sendRegistration() {
		this.client.publish(
			"qvac/register",
			JSON.stringify({
				runId: this.runId,
				consumerId: this.consumerId,
				platform: this.platform,
				timestamp: new Date().toISOString(),
			}),
			{ qos: 1 }
		);
	}

	protected handleRegistrationAck(message: any) {
		this.log(`🔌 Registration ack - ${message.totalTests} tests in queue\n`);
		this.registered = true;
		this.updateStats({ totalTests: message.totalTests });
		this.requestNextTest();
	}

	protected async handleTestAssignment(assignment: TestAssignment) {
		if (assignment.status === "queue-empty") {
			this.log("📭 No more tests in queue");
			if (!this.isProcessingTest) {
				this.shutdown();
			}
			return;
		}

		if (assignment.status === "assigned" && assignment.test && assignment.uniqueTestId) {
			await this.executeTest(assignment.uniqueTestId, assignment.test);
		}
	}

	protected handleBatchComplete(message: any) {
		this.log("\n🎉 Batch complete!");
		this.log(`📊 Total: ${message.totalTests}`);
		this.log(`✅ Passed: ${message.successCount}`);
		this.log(`❌ Failed: ${message.failureCount}`);
		this.log(`⏱️  Duration: ${(message.duration / 1000).toFixed(2)}s`);

		this.shutdownRequested = true;
		this.updateStats({ isComplete: true });
		
		if (!this.isProcessingTest) {
			this.shutdown();
		}
	}

	protected async executeTest(uniqueTestId: string, test: TestMessage) {
		this.isProcessingTest = true;
		const { testId, params, expectation } = test;

		this.log(`▶️  ${testId}`);
		this.updateStats({ currentTest: testId });

		// Notify producer that test has started
		this.client.publish(
			"qvac/test-start",
			JSON.stringify({
				runId: this.runId,
				consumerId: this.consumerId,
				uniqueTestId,
				timestamp: new Date().toISOString(),
			}),
			{ qos: 1 }
		);

		const startTime = Date.now();

		try {
			// Ensure required model is loaded for this test
			let modelId = await this.ensureModelForTest(testId);

			// Calculate timeout based on test type
			const timeoutMs = this.getTestTimeout(testId);

			// Execute the test with timeout
			let testPromise = this.executor.executeTest(testId, modelId, params, expectation);
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(
					() => reject(new Error(`Test timeout after ${timeoutMs / 1000}s`)),
					timeoutMs
				);
			});

			let result;
			try {
				result = await Promise.race([testPromise, timeoutPromise]);
			} catch (error: any) {
				result = { passed: false, output: `Error: ${error.message}` };
			}

			const shouldExpectFailure = expectation?.errorExpected === true ||
																	expectation?.type === 'error' ||
																	expectation?.validation === 'throws-error' ||
																	expectation?.validation === 'throws-structured-error' ||
																	expectation?.validation === 'handles-error';
			const outputStr = result?.output || '';
			const isModelNotFound = !result.passed && 
				outputStr.includes("not found") && 
				outputStr.includes("Model with ID");
			
			if (isModelNotFound && !shouldExpectFailure) {
				this.log(`   ⚠️  Model not found in result, reloading and retrying...`);
				// Clear cached model ID to force reload
				const modelType = this.getRequiredModelType(testId);
				if (modelType === 'llm') this.llmModelId = null;
				else if (modelType === 'embedding') this.embeddingModelId = null;
				else if (modelType === 'whisper') this.whisperModelId = null;
				else if (modelType === 'tools') this.toolsModelId = null;
				else if (modelType === 'nmt') this.nmtModelId = null;
				else if (modelType === 'vision') this.visionModelId = null;
				else if (modelType === 'tts') this.ttsModelId = null;
				
				// Reload model
				modelId = await this.ensureModelForTest(testId);
				this.log(`   🔄 Retrying with new model ID: ${modelId}`);
				
				try {
					testPromise = this.executor.executeTest(testId, modelId, params, expectation);
					result = await Promise.race([testPromise, timeoutPromise]);
				} catch (retryError: any) {
					result = { passed: false, output: `Error after retry: ${retryError.message}` };
				}
			}

			const duration = Date.now() - startTime;
			const outcome = result.passed ? "success" : "failure";

			this.log(`${outcome === "success" ? "✅" : "❌"} ${testId} (${duration}ms)`);
			if (!result.passed && result.output) {
				this.log(`   ${result.output.substring(0, 100)}`);
			}

			// Update model ID if test returned a new one
			if (result.modelId) {
				if (testId.startsWith("model-load-llm") || testId.startsWith("model-switch") || testId.startsWith("model-reload") || testId.startsWith("completion")) {
					this.llmModelId = result.modelId;
				} else if (testId.startsWith("model-load-embedding")) {
					this.embeddingModelId = result.modelId;
				} else if (testId.startsWith("model-load-whisper")) {
					this.whisperModelId = result.modelId;
				}
			}

			// Update stats
			this.testsCompleted++;
			if (outcome === "success") {
				this.testsPassed++;
			} else {
				this.testsFailed++;
			}
			
			this.updateStats({
				testsCompleted: this.testsCompleted,
				testsPassed: this.testsPassed,
				testsFailed: this.testsFailed,
			});

			// Send result to producer
			this.client.publish(
				"qvac/results",
				JSON.stringify({
					runId: this.runId,
					consumerId: this.consumerId,
					testId,
					uniqueTestId,
					outcome,
					duration,
					timestamp: new Date().toISOString(),
					error: result.passed ? undefined : result.output,
				}),
				{ qos: 1 }
			);
		} catch (error: any) {
			const duration = Date.now() - startTime;
			const errorMsg = error.message || "Unknown error";

			this.log(`❌ ${testId} failed: ${errorMsg}`);

			// Check if this looks like an SDK crash/hang
			const isSdkCrash = errorMsg.includes("timeout") || errorMsg.includes("hung") || errorMsg.includes("GGML");
			if (isSdkCrash) {
				await this.attemptCrashRecovery();
			}

			// Update stats
			this.testsCompleted++;
			this.testsFailed++;
			this.updateStats({
				testsCompleted: this.testsCompleted,
				testsFailed: this.testsFailed,
			});

			// Send failure result
			this.client.publish(
				"qvac/results",
				JSON.stringify({
					runId: this.runId,
					consumerId: this.consumerId,
					testId,
					uniqueTestId,
					outcome: "failure",
					duration,
					timestamp: new Date().toISOString(),
					error: errorMsg,
					sdkCrash: isSdkCrash ? true : undefined,
				}),
				{ qos: 1 }
			);
		} finally {
			this.isProcessingTest = false;

			if (!this.shutdownRequested) {
				setTimeout(() => this.requestNextTest(), 100);
			}
		}
	}

	protected getTestTimeout(testId: string): number {
		const isDestructiveTest = testId.includes("embed-python") || testId.includes("embed-javascript") || 
		                          testId.includes("embed-json") || testId.includes("embed-html") ||
		                          testId.includes("very-long") || testId.includes("extremely-long") ||
		                          testId.includes("corrupted");
		const isLargeRagTest = testId.includes("rag-large");
		const isMediumRagTest = testId.includes("rag-medium");
		const isSmallRagTest = testId.includes("rag-small");
		const isLongPromptTest = testId === "completion-long-prompt";
		const isTranscriptionTest = testId.startsWith("transcription-");
		const isToolsTest = testId.startsWith("tools-");
		const isEmbeddingTest = testId.startsWith("embed-") || testId.startsWith("rag-");
		const isTtsTest = testId.startsWith("tts-");
		
		// Mobile devices need more time for heavy operations
		const isMobile = this.platform === "mobile" || this.platform.includes("mobile");
		const mobileMultiplier = isMobile ? 1.5 : 1.0; // 50% more time on mobile
		
		if (isDestructiveTest) {
			return 10000; // 10s
		} else if (isLargeRagTest) {
			return Math.round(120000 * mobileMultiplier); // 120s desktop, 180s mobile
		} else if (isMediumRagTest) {
			return Math.round(90000 * mobileMultiplier); // 90s desktop, 135s mobile
		} else if (isSmallRagTest || isLongPromptTest) {
			return Math.round(60000 * mobileMultiplier); // 60s desktop, 90s mobile
		} else if (isTranscriptionTest) {
			return Math.round(60000 * mobileMultiplier); // 60s desktop, 90s mobile
		} else if (isTtsTest) {
			// TTS tests: longer timeout for stack overflow prevention tests (QVAC-9403)
			const isLongTts = testId.includes("stack-overflow") || testId.includes("very-long") || 
			                  testId.includes("extremely-long") || testId.includes("large-buffer");
			if (isLongTts) {
				return Math.round(90000 * mobileMultiplier); // 90s desktop, 135s mobile for large buffer tests
			}
			return Math.round(45000 * mobileMultiplier); // 45s desktop, 67.5s mobile for regular TTS
		} else if (isToolsTest && isMobile) {
			return 90000; // 90s for tools tests on mobile (QWEN 7B is heavy)
		} else if (isEmbeddingTest && isMobile) {
			return 90000; // 90s for embedding tests on mobile (GTE_LARGE is heavy)
		} else {
			return 60000; // 60s default
		}
	}

	protected async attemptCrashRecovery() {
		this.log(`   ⚠️  SDK CRASH DETECTED - attempting recovery...`);
		try {
			// Import unloadModel - must be provided by subclass
			const { unloadModel } = await this.getSDKFunctions();

			if (this.llmModelId) {
				await unloadModel({ modelId: this.llmModelId });
				this.llmModelId = null;
				this.log(`   🔄 Unloaded LLM model`);
			}
			if (this.whisperModelId) {
				await unloadModel({ modelId: this.whisperModelId });
				this.whisperModelId = null;
				this.log(`   🔄 Unloaded Whisper model`);
			}
			if (this.embeddingModelId) {
				await unloadModel({ modelId: this.embeddingModelId });
				this.embeddingModelId = null;
				this.log(`   🔄 Unloaded Embedding model`);
			}
			if (this.translationModelId) {
				await unloadModel({ modelId: this.translationModelId });
				this.translationModelId = null;
				this.log(`   🔄 Unloaded Translation model`);
			}
			this.log(`   ✅ Recovery complete - models will reload on next test`);
		} catch (recoveryError: any) {
			this.log(`   ⚠️  Recovery failed: ${recoveryError?.message || String(recoveryError)}`);
			this.log(`   ℹ️  Subsequent tests may fail (cascade effect)`);
		}
	}

	// Abstract method to get SDK functions (platform-specific)
	protected abstract getSDKFunctions(): Promise<{ unloadModel: any }>;

	protected shutdown() {
		this.log("\n👋 Consumer shutting down...");
		this.client.end(false, {}, () => {
			if (this.callbacks.onShutdown) {
				this.callbacks.onShutdown();
			}
		});
		if(process?.exit)
			process.exit(0);
	}

	public forceShutdown() {
		this.log("⚠️  Force shutdown - closing immediately");
		this.shutdown();
	}
}


