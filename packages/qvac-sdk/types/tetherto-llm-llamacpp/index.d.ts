declare module "@qvac/llm-llamacpp" {
  export interface LlmConfig {
    temperature?: number;
    top_k?: number;
    top_p?: number;
    min_p?: number;
    n_predict?: number;
    n_keep?: number;
    stream?: boolean;
    penalty_last_n?: number;
    repeat_penalty?: number;
    penalty_freq?: number;
    penalty_present?: number;
    typical_p?: number;
    tfs_z?: number;
    mirostat?: number;
    mirostat_tau?: number;
    mirostat_eta?: number;
    grammar?: string;
    seed?: number;
    ignore_eos?: boolean;
    logit_bias?: Record<string, number>;
    n_probs?: number;
    min_keep?: number;
    grammar_trigger_mode?: number;
    samplers_sequence?: string;
    use_penalty_prompt_tokens?: boolean;
    presence_penalty?: number;
    frequency_penalty?: number;
    dry_multiplier?: number;
    dry_base?: number;
    dry_allowed_length?: number;
    dry_penalty_last_n?: number;
    dry_sequence_breakers?: string[];
    dry_range?: number;
    dry_repetition_penalty?: number;
    dry_limit?: number;
    dry_score_range?: number;
    xtc_probability?: number;
    xtc_threshold?: number;
    top_n_sigma?: number;
    min_temp?: number;
    max_temp?: number;
    temperature_smoothing?: number;
    dynatemp_range?: number;
    dynatemp_exponent?: number;
    reverse_prompt?: string; // SDK uses stop_sequences: string[] which gets converted to ", " separated string
    n_discarded?: number;
  }

  export interface LlmArgs {
    loader: unknown;
    modelPath: string;
    modelConfig: Record<string, string>;
    systemPrompt?: string;
    chatTemplate?: string;
  }

  export interface CompletionResponse {
    text: string;
    tokens_predicted: number;
    tokens_evaluated: number;
    truncated: boolean;
    stopped_eos: boolean;
    stopped_word: boolean;
    stopped_limit: boolean;
    stopping_word: string;
    tokens_cached: number;
    timings: {
      predicted_per_token_ms: number;
      predicted_per_second: number;
      predicted_ms: number;
      predicted_n: number;
      evaluated_per_token_ms: number;
      evaluated_per_second: number;
      evaluated_ms: number;
      evaluated_n: number;
    };
  }

  export default class LlmLlamacpp {
    constructor(args: LlmArgs, config: Record<string, string>);

    load(verbose?: boolean): Promise<void>;
    completion(prompt: string, config?: LlmConfig): Promise<CompletionResponse>;
    streamCompletion(
      prompt: string,
      config?: LlmConfig,
    ): AsyncGenerator<string>;
    unload(): Promise<void>;
  }
}

declare module "@qvac/llm-llamacpp/addonLogging" {
  interface AddonLogging {
    setLogger(callback: (priority: number, message: string) => void): void;
    releaseLogger(): void;
  }
  const addonLogging: AddonLogging;
  export default addonLogging;
}
