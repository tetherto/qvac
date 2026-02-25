// Shared model manager - loads models once and reuses across executors
import {
  loadModel,
  LLAMA_3_2_1B_INST_Q4_0,
  GTE_LARGE_FP16,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
  QWEN3_1_7B_INST_Q4,
} from "@qvac/sdk";

export class ModelManager {
  private static llmModelId: string | null = null;
  private static embeddingModelId: string | null = null;
  private static whisperModelId: string | null = null;
  private static toolsModelId: string | null = null;

  // Allow external setting (for model loading tests that load directly)
  static setLlmModel(modelId: string) {
    console.log(
      `    [ModelManager] Registering externally loaded LLM: ${modelId}`,
    );
    this.llmModelId = modelId;
  }

  static setEmbeddingModel(modelId: string) {
    console.log(
      `    [ModelManager] Registering externally loaded Embedding: ${modelId}`,
    );
    this.embeddingModelId = modelId;
  }

  static async getLlmModel(): Promise<string> {
    if (!this.llmModelId) {
      console.log(
        "    [ModelManager] Loading LLM model (LLAMA 1B) - will be shared...",
      );
      const modelId = await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        modelConfig: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
      });
      this.llmModelId = modelId;
      console.log(`    [ModelManager] LLM loaded: ${modelId}`);
    } else {
      console.log(`    [ModelManager] Reusing LLM model: ${this.llmModelId}`);
    }
    if (!this.llmModelId) {
      throw new Error("LLM model was not loaded");
    }
    return this.llmModelId;
  }

  static async getEmbeddingModel(): Promise<string> {
    if (!this.embeddingModelId) {
      console.log("    Loading Embedding model (shared)...");
      const modelId = await loadModel({
        modelSrc: GTE_LARGE_FP16,
        modelType: "embeddings",
      });
      this.embeddingModelId = modelId;
    }
    if (!this.embeddingModelId) {
      throw new Error("Embedding model was not loaded");
    }
    return this.embeddingModelId;
  }

  static async getWhisperModel(): Promise<string> {
    if (!this.whisperModelId) {
      console.log("    Loading Whisper model (shared)...");
      const modelId = await loadModel({
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
      this.whisperModelId = modelId;
    }
    if (!this.whisperModelId) {
      throw new Error("Whisper model was not loaded");
    }
    return this.whisperModelId;
  }

  static async getToolsModel(): Promise<string> {
    if (!this.toolsModelId) {
      console.log("    [ModelManager] Loading Tools model (Qwen 7B)...");
      const modelId = await loadModel({
        modelSrc: QWEN3_1_7B_INST_Q4,
        modelType: "llm",
        modelConfig: {
          ctx_size: 4096, // Qwen needs larger context for tools
          tools: true, // Enable function calling
        },
      });
      this.toolsModelId = modelId;
      console.log(`    [ModelManager] Qwen loaded: ${modelId}`);
    } else {
      console.log(
        `    [ModelManager] Reusing Qwen model: ${this.toolsModelId}`,
      );
    }
    if (!this.toolsModelId) {
      throw new Error("Tools model was not loaded");
    }
    return this.toolsModelId;
  }

  static reset() {
    this.llmModelId = null;
    this.embeddingModelId = null;
    this.whisperModelId = null;
    this.toolsModelId = null;
  }
}
