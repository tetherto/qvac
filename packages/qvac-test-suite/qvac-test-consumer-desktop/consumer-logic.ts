import { ConsumerBase, type ConsumerCallbacks } from "../shared-consumer/consumer-base";
import type { MqttClient } from "mqtt";
import {
	loadModel,
	unloadModel,
	LLAMA_3_2_1B_INST_Q4_0,
	WHISPER_TINY,
	VAD_SILERO_5_1_2,
	GTE_LARGE_FP16,
	QWEN_3_1_7B_INST_Q4,
	SMOLVLM2_2_500M_MULTIMODAL_Q8_0,
	MMPROJ_SMOLVLM2_2_500M_MULTIMODAL_Q8_0,
	TTS_PIPER_NORMAN_EN_US_ONNX_MEDIUM,
	TTS_PIPER_NORMAN_EN_US_ONNX_MEDIUM_CONFIG,
	MARIAN_OPUS_DE_EN_Q0F32,
	BERGAMOT_ENFR, // QVAC-10524: Bergamot translation engine
	OCR_CRAFT_LATIN_RECOGNIZER_1,
} from "@tetherto/sdk-dev";

export class DesktopConsumer extends ConsumerBase {
	constructor(
		client: MqttClient,
		consumerId: string,
		platform: string,
		runId: string,
		executor: any,
		callbacks: ConsumerCallbacks
	) {
		super(client, consumerId, platform, runId, executor, callbacks);
	}

	protected async loadLlmModel(): Promise<string> {
		return await loadModel({
			modelSrc: LLAMA_3_2_1B_INST_Q4_0,
			modelType: "llm",
			modelConfig: {
				verbosity: 0,
				ctx_size: 2048,
				n_discarded: 256,
			},
		});
	}

	protected async loadWhisperModel(): Promise<string> {
		return await loadModel({
			modelSrc: WHISPER_TINY,
			modelType: "whisper",
			vadModelSrc: VAD_SILERO_5_1_2,
			modelConfig: {
				audio_format: "f32le",
				strategy: "greedy",
				language: "en",
				translate: false,
				no_timestamps: false,
				single_segment: false,
				temperature: 0.0,
				suppress_blank: true,
				suppress_nst: true,
				vad_params: {
					threshold: 0.35,
					min_speech_duration_ms: 200,
					min_silence_duration_ms: 150,
					max_speech_duration_s: 30.0,
					speech_pad_ms: 600,
					samples_overlap: 0.3,
				},
			},
		});
	}

	protected async loadEmbeddingModel(): Promise<string> {
		return await loadModel({
			modelSrc: GTE_LARGE_FP16,
			modelType: "embeddings",
		});
	}

	protected async loadToolsModel(): Promise<string> {
		return await loadModel({
			modelSrc: QWEN_3_1_7B_INST_Q4,
			modelType: "llm",
			modelConfig: {
				ctx_size: 4096,
				tools: true,
			},
		});
	}

	protected async loadVisionModel(): Promise<string> {
		return await loadModel({
			modelSrc: SMOLVLM2_2_500M_MULTIMODAL_Q8_0,
			modelType: "llm",
			projectionModelSrc: MMPROJ_SMOLVLM2_2_500M_MULTIMODAL_Q8_0,
			modelConfig: {
				ctx_size: 1024,
			},
		});
	}

	protected async loadTtsModel(): Promise<string> {
		return await loadModel({
			modelSrc: TTS_PIPER_NORMAN_EN_US_ONNX_MEDIUM,
			modelType: "tts",
			configSrc: TTS_PIPER_NORMAN_EN_US_ONNX_MEDIUM_CONFIG,
			eSpeakDataPath: this.getESpeakDataPath(),
			modelConfig: {
				language: "en",
			},
		});
	}

	protected async loadNmtModel(): Promise<string> {
		// QVAC-9401: NMT model with generation parameters
		// QVAC-10524: Added engine: "Opus" (required after QVAC-9526)
		return await loadModel({
			modelSrc: MARIAN_OPUS_DE_EN_Q0F32,
			modelType: "nmt",
			modelConfig: {
				engine: "Opus",
				from: "de",
				to: "en",
				// Generation parameters (QVAC-9401)
				beamsize: 4,
				lengthpenalty: 1.0,
				maxlength: 512,
				temperature: 0.3,
				norepeatngramsize: 3,
			},
		});
	}

	protected async loadBergamotModel(): Promise<string> {
		// QVAC-10524: Bergamot translation engine support
		return await loadModel({
			modelSrc: BERGAMOT_ENFR,
			modelType: "nmt",
			modelConfig: {
				engine: "Bergamot",
				from: "en",
				to: "fr",
			},
		});
	}

	protected async loadOcrModel(): Promise<string> {
		// Only need to pass the recognizer - detector is auto-derived
		return await loadModel({
			modelSrc: OCR_CRAFT_LATIN_RECOGNIZER_1,
			modelType: "ocr",
			modelConfig: {
				langList: ["en"],
			},
		});
	}

	protected async getSDKFunctions() {
		return { unloadModel };
	}
}

