
---

# Whisper.cpp Parameter Configuration Report

## Overview
This document describes how to configure key Whisper parameters in C++ using the whisper.cpp API. Parameters are categorized by their implementation method and usage.

---

## Direct API Parameters

### beam-size
- **API Field:** `wparams.beam_search.beam_size`
- **Type:** int
- **C++ Configuration:**
  ```cpp
  whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
  wparams.beam_search.beam_size = 5;
  ```
- **Notes:** Only used in BEAM SEARCH mode.

### temperature
- **API Field:** `wparams.temperature`
- **Type:** float
- **C++ Configuration:**
  ```cpp
  whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  wparams.temperature = 1.0f;
  ```
- **Notes:** Controls randomness in output.

### n_max_text_ctx
- **API Field:** `wparams.max_context`
- **Type:** int
- **C++ Configuration:**
  ```cpp
  whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  wparams.max_context = 4096;
  ```
- **Notes:** Max tokens of context.

### no_speech_threshold
- **API Field:** `wparams.no_speech_thold`
- **Type:** float
- **C++ Configuration:**
  ```cpp
  whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  wparams.no_speech_thold = 0.6f;
  ```
- **Notes:** Threshold for silence detection.

### chunk_length_s
- **API Field:** `wparams.duration_ms`
- **Type:** int (milliseconds)
- **C++ Configuration:**
  ```cpp
  whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  wparams.duration_ms = 30000; // 30 seconds
  ```
- **Notes:** Set in milliseconds. Controls max audio chunk length.

### max_seconds
- **API Field:** `wparams.duration_ms`
- **Type:** int (milliseconds)
- **C++ Configuration:**
  ```cpp
  whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  wparams.duration_ms = max_seconds * 1000;
  ```
- **Notes:** Set in milliseconds. Controls max audio duration to process.

---

## VAD-Specific Parameters

### vad_model
- **API Function:** `whisper_vad_init_from_file_with_params()`
- **Type:** string
- **C++ Configuration:**
  ```cpp
  whisper_vad_context_params params = whisper_vad_default_context_params();
  whisper_vad_context* ctx = whisper_vad_init_from_file_with_params(vad_model_path.c_str(), params);
  ```
- **Notes:** Path to VAD model file. Used with VAD-enabled models.

### vad_threshold
- **API Field:** `wparams.threshold` (in VAD params)
- **Type:** float
- **C++ Configuration:**
  ```cpp
  whisper_vad_params params = whisper_vad_default_params();
  params.threshold = 0.6f;
  ```
- **Notes:** Probability threshold for VAD speech detection.

### vad_min_silence_duration_ms
- **API Field:** `wparams.min_silence_duration_ms` (in VAD params)
- **Type:** int
- **C++ Configuration:**
  ```cpp
  whisper_vad_params params = whisper_vad_default_params();
  params.min_silence_duration_ms = 500;
  ```
- **Notes:** Minimum silence duration to split speech segments in VAD.

---

## Application Logic Parameters

### batch_size
- **Implementation:** Application logic (number of segments processed per batch)
- **Type:** int
- **C++ Configuration:**
  ```cpp
  // No direct field in whisper_full_params or whisper.cpp API.
  // In your model, batch processing means splitting the audio into segments
  // (e.g., via VAD or chunking) and transcribing each segment individually:
  for (const auto& segment : segments) {
      whisper_full(ctx, wparams, segment.audio_samples.data(), segment.audio_samples.size());
  }
  ```
- **Notes:** There is no direct batch_size parameter in whisper.cpp. In your model, "batch" refers to processing multiple segments (from one audio) sequentially or in parallel. If you want to process multiple audios in parallel, you must manage that in your application logic.

### mode
- **Implementation:** Application logic (not direct API parameter)
- **Type:** string
- **C++ Configuration:**
  ```cpp
  // Implement caption mode in postProcess() or use different model classes
  // Example: Different model classes for different modes
  if (mode == "caption") {
      whisperModel_ = std::make_unique<WhisperDefaultCaptionModel>(model_path_);
  } else {
      whisperModel_ = std::make_unique<WhisperDefaultBatchModel>(model_path_);
  }
  ```
- **Notes:** Mode is handled at application level, not in whisper.cpp API.

### min_seconds
- **Implementation:** Application logic (filter segments after VAD)
- **Type:** float
- **C++ Configuration:**
  ```cpp
  // Filter short segments after VAD detection
  for (const auto& segment : segments) {
      float duration = segment.end_time_s - segment.start_time_s;
      if (duration < min_seconds) continue; // Skip short segments
      
      // Process segment...
  }
  ```
- **Notes:** No direct parameter in whisper.cpp. Filter short segments after VAD detection in your application logic.

### output_format
- **Implementation:** Application logic (format results)
- **Type:** string
- **C++ Configuration:**
  ```cpp
  // Format transcripts in postProcess() or output handling
  Output postProcess(const Output& transcripts) {
      // Format according to output_format parameter
      if (output_format == "json") {
          return formatAsJson(transcripts);
      } else if (output_format == "txt") {
          return formatAsText(transcripts);
      }
      return transcripts;
  }
  ```
- **Notes:** No direct parameter in whisper.cpp. Handle output formatting in your application.

---

## Summary

- **Direct API Parameters:** These are passed directly to whisper.cpp API functions and structures.
- **VAD-Specific Parameters:** These are used only when Voice Activity Detection is enabled.
- **Application Logic Parameters:** These are implemented in your application layer and not directly supported by whisper.cpp API.

All parameters marked as "Application Logic" require custom implementation in your codebase, as they are not part of the core whisper.cpp API.

# Whisper commands defined for whisper-cli

---

## n_threads (👍🏼)

### 1. Description
Sets the number of CPU threads to use for audio transcription. This parameter controls how many threads are used in parallel for processing, directly affecting performance and resource usage.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -t 8 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --threads 8 -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

**How it is used in whisper.cpp:**
- The value is set in the `whisper_params` struct as `n_threads`.
- When preparing for inference, it is passed to the `whisper_full_params` struct, which is then used in the main inference call.

**Relevant code:**
```c++
// Set up whisper_full_params
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
wparams.n_threads = params.n_threads;

// Main inference call
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

**Summary:**
You set `wparams.n_threads` before calling `whisper_full()`. This tells whisper.cpp how many CPU threads to use for the transcription.

---

## n_processors (👍🏼)

### 1. Description
Specifies the number of parallel processes for batch processing in the CLI. It is used only by the CLI to process multiple files in parallel, not for model inference itself.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -p 4 -m models/ggml-base.en.bin -f audio1.wav audio2.wav audio3.wav
```
or
```sh
whisper-cli --processors 4 -m models/ggml-base.en.bin -f audio1.wav audio2.wav
```

### 3. C++ Implementation Snippet

**How it is used in whisper.cpp:**
- The value is set in the `whisper_params` struct as `n_processors`.
- It is used in the CLI to spawn multiple processes/threads to process multiple input files in parallel.
- **It is not passed to the whisper.cpp API or used in the inference call.**

**Relevant code:**
```cpp
// In the CLI main loop (pseudo-code)
for (int i = 0; i < params.n_processors; ++i) {
    // Each processor/thread handles a different input file
    std::thread([&](){
        // For each file assigned to this processor:
        whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
    }).detach();
}
```
**Note:**  
This is CLI logic for batch file processing. It does **not** affect the actual inference API or single-audio processing.

---

## offset_t_ms

### 1. Description
Specifies the number of milliseconds to skip at the beginning of the audio before starting transcription. Useful for processing only a segment of the audio or resuming from a specific point.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -ot 5000 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --offset-t 5000 -m models/ggml-base.en.bin -f audio.wav
```
*(This skips the first 5000 ms = 5 seconds of the audio.)*

### 3. C++ Implementation Snippet

**How it is used in whisper.cpp:**
- The value is set in the `whisper_params` struct as `offset_t_ms`.
- It is passed to the `whisper_full_params` struct as `offset_ms`.
- The `whisper_full_params` is then used in the main inference call.

**Relevant code:**
```cpp
// Set up whisper_full_params
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
wparams.offset_ms = params.offset_t_ms;

// Main inference call
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

**Summary:**  
Set `wparams.offset_ms` to the desired millisecond offset before calling `whisper_full()`. The model will skip that amount of audio at the start.


---

## offset_n

### 1. Description
Specifies the number of audio samples to skip at the beginning of the audio before starting transcription. This is a lower-level alternative to `offset_t_ms` (which uses milliseconds).

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -on 16000 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --offset-n 16000 -m models/ggml-base.en.bin -f audio.wav
```
*(This skips the first 16,000 audio samples.)*

### 3. C++ Implementation Snippet

```cpp
// Set up whisper_full_params
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
wparams.offset_n = params.offset_n;

// Main inference call
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## duration_ms (👍🏼)

### 1. Description
Limits the maximum duration (in milliseconds) of audio to transcribe. Only the specified duration from the start (after any offset) will be processed.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -d 10000 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --duration 10000 -m models/ggml-base.en.bin -f audio.wav
```
*(This transcribes only the first 10,000 ms = 10 seconds of audio, after any offset.)*

### 3. C++ Implementation Snippet

```cpp
// Set up whisper_full_params
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
wparams.duration_ms = params.duration_ms;

// Main inference call
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## max_context (👍🏼)

### 1. Description
Sets the maximum number of text tokens from previous segments to use as context for the current segment during transcription. Controls how much past context the model considers.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -mc 256 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --max-context 256 -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Set up whisper_full_params
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
wparams.n_max_text_ctx = params.max_context;

// Main inference call
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## max_len (👍🏼)

### 1. Description
Sets the maximum number of tokens that can be generated in each transcription segment. Limits the length of the output per segment.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -ml 32 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --max-len 32 -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Set up whisper_full_params
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
wparams.max_len = params.max_len;

// Main inference call
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## best_of

### 1. Description
Specifies the number of candidate completions to generate in greedy decoding mode. The model will generate multiple completions and select the one with the highest average log probability per token.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -bo 3 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --best-of 3 -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -bo 3 ...`

// 1. Create default parameters for GREEDY decoding
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the number of candidates to generate (from CLI: -bo 3)
wparams.greedy.best_of = 3;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## beam_size (👍🏼)

### 1. Description
Sets the beam size for beam search decoding. Higher values can improve transcription accuracy at the cost of increased computation and latency.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -bs 5 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --beam-size 5 -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -bs 5 ...`

// 1. Create default parameters for BEAM SEARCH decoding
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);

// 2. Set the beam size (from CLI: -bs 5)
wparams.beam_search.beam_size = 5;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## audio_ctx (👍🏼)

### 1. Description
Sets the audio context window size (in samples) used for processing. This controls how much audio is considered at once for each inference segment.

**What does this value represent?**  
The `audio_ctx` parameter defines how many audio samples the model "sees" at a time when generating transcriptions. For example, if you set `-ac 2048`, the model processes the audio in blocks of 2048 samples per inference step.  
- **Lower values** (e.g., 512, 1024): Less memory usage, but less context for the model (may reduce transcription quality).
- **Higher values** (e.g., 2048, 4096): More context for the model (may improve quality), but higher memory usage and potentially slower processing.

**Note:**  
The default value is usually optimal for most use cases. Only change this if you have specific needs (e.g., low-memory devices or very long audio files).

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -ac 2048 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --audio-ctx 2048 -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -ac 2048 ...`

// 1. Create default parameters (any decoding mode)
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the audio context window size (from CLI: -ac 2048)
wparams.audio_ctx = 2048;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## word_thold

### 1. Description
Sets the probability threshold for accepting a word in the transcription. Words with a confidence (probability) below this threshold will not be assigned a timestamp or may be omitted from the output.

**What does this value represent?**  
The `word_thold` parameter controls the minimum confidence required for a word to be considered valid and included in the output.  
- **Lower values** (e.g., 0.01): More words will be included, even if the model is less confident.
- **Higher values** (e.g., 0.1): Only words with high confidence will be included, which may reduce false positives but can also omit some correct words.

**Note:**  
This is mainly useful for fine-tuning word-level timestamp accuracy or filtering out uncertain words in noisy audio.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -wt 0.02 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --word-thold 0.02 -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -wt 0.02 ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the word probability threshold (from CLI: -wt 0.02)
wparams.word_thold = 0.02f;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## entropy_thold

### 1. Description
Sets the entropy threshold for filtering uncertain words in the transcription. Words with an entropy above this threshold are considered too uncertain and may be omitted from the output.

**What does this value represent?**  
The `entropy_thold` parameter controls how tolerant the model is to uncertainty in word predictions.  
- **Lower values** (e.g., 1.0): Only very certain words are included.
- **Higher values** (e.g., 2.4): More uncertain words are allowed in the output.

**Note:**  
This parameter is mainly for advanced tuning and is useful in noisy environments or when you want to filter out words the model is unsure about.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -et 2.0 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --entropy-thold 2.0 -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -et 2.0 ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the entropy threshold (from CLI: -et 2.0)
wparams.entropy_thold = 2.0f;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## logprob_thold

### 1. Description
Sets the log-probability threshold for filtering words in the transcription. Words with a log-probability below this threshold are considered too uncertain and may be omitted from the output.

**What does this value represent?**  
The `logprob_thold` parameter determines the minimum log-probability a word must have to be included in the output.  
- **Lower values** (e.g., -2.0): More words are included, even if the model is less confident.
- **Higher values** (e.g., -0.5): Only words with higher confidence are included.

**Note:**  
This is an advanced parameter, mainly useful for filtering out words in noisy audio or for fine-tuning the output quality.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -lpt -1.5 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --logprob-thold -1.5 -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -lpt -1.5 ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the log-probability threshold (from CLI: -lpt -1.5)
wparams.logprob_thold = -1.5f;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## no_speech_thold(👍🏼)

### 1. Description
Sets the probability threshold for detecting "no speech" (silence) in the audio. If the model's confidence for speech is below this threshold, the segment is considered silence and may be skipped.

**What does this value represent?**  
The `no_speech_thold` parameter controls how sensitive the model is to silence detection.  
- **Lower values** (e.g., 0.3): The model is less likely to skip segments as silence.
- **Higher values** (e.g., 0.8): The model is more aggressive in skipping low-confidence (silent) segments.

**Note:**  
This is useful for controlling silence detection in noisy or quiet environments, and for applications where accurate segmentation of speech and silence is important.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -nth 0.5 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --no-speech-thold 0.5 -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -nth 0.5 ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the no speech threshold (from CLI: -nth 0.5)
wparams.no_speech_thold = 0.5f;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## grammar_penalty

### 1. Description
Sets a penalty value for grammar-based decoding. This parameter is only relevant if you are using a custom grammar for constrained transcription.

**What does this value represent?**  
The `grammar_penalty` parameter controls how strongly the model penalizes outputs that do not conform to the specified grammar.  
- **Higher values** (e.g., 100.0): Stronger penalty for deviating from the grammar.
- **Lower values** (e.g., 1.0): Weaker penalty, allowing more flexibility.

**Note:**  
This parameter is only used when a custom grammar is provided. For most standard transcription tasks, it is not needed.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --grammar-penalty 50.0 --grammar mygrammar.gbnf -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --grammar-penalty 50.0 ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the grammar penalty (from CLI: --grammar-penalty 50.0)
wparams.grammar_penalty = 50.0f;

// 3. Run inference (assuming grammar is also set)
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## temperature(👍🏼)

### 1. Description
Controls the randomness of the transcription output. Lower values make the output more deterministic, while higher values increase diversity (but may reduce accuracy).

**What does this value represent?**  
The `temperature` parameter is used in sampling-based decoding to control how likely the model is to pick less probable tokens.  
- **Lower values** (e.g., 0.0–0.5): Output is more predictable and repetitive.
- **Higher values** (e.g., 1.0–2.0): Output is more diverse and creative, but may introduce errors.

**Note:**  
For most transcription use cases, a value of 0.0 or 1.0 is typical. Higher values are mainly for experimentation or creative applications.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -tp 0.7 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --temperature 0.7 -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -tp 0.7 ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the temperature (from CLI: -tp 0.7)
wparams.temperature = 0.7f;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## temperature_inc

### 1. Description
Sets the increment value for temperature when sampling fails to produce a valid output. If the model cannot generate a valid transcription at the initial temperature, it will retry with increased temperature by this amount.

**What does this value represent?**  
The `temperature_inc` parameter is used for adaptive sampling. If the model gets stuck or produces invalid output, the temperature is increased by this value and sampling is retried, making the output more diverse.

**Note:**  
This is an advanced parameter, mainly useful for edge cases or when working with very difficult audio. For most users, the default value is sufficient.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -tpi 0.2 -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --temperature-inc 0.2 -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -tpi 0.2 ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the temperature increment (from CLI: -tpi 0.2)
wparams.temperature_inc = 0.2f;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## translate (👍🏼)

### 1. Description
If enabled, the model will translate the transcribed audio into English, regardless of the original spoken language.

**What does this value represent?**  
The `translate` parameter tells the model to output English text even if the input audio is in another language. This is useful for automatic translation applications.

**Note:**  
This is a core feature of Whisper models and is supported natively by the API.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -tr -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --translate -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -tr ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Enable translation to English (from CLI: -tr)
wparams.translate = true;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## detect_language(👍🏼)

### 1. Description
If enabled, the model will automatically detect the spoken language in the audio before transcribing or translating.

**What does this value represent?**  
The `detect_language` parameter allows the model to determine the language of the input audio automatically, which is useful for multi-language or unknown-language scenarios.

**Note:**  
If not enabled, you must specify the language manually using the `language` parameter.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -dl -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --detect-language -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -dl ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Enable automatic language detection (from CLI: -dl)
wparams.detect_language = true;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## diarize(👍🏼)

### 1. Description
Enables speaker diarization, which attempts to identify and separate different speakers in the audio.

**What does this value represent?**  
The `diarize` parameter instructs the model to perform speaker diarization, labeling segments of the transcript according to different speakers.  
This is useful for meetings, interviews, or any multi-speaker scenario.

**Note:**  
Diarization support depends on the model and build configuration. Not all models or builds support this feature.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -di -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --diarize -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -di ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Enable diarization (from CLI: -di)
wparams.diarize = true;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## tinydiarize(👍🏼)

### 1. Description
Enables a simplified or lightweight version of speaker diarization, which attempts to distinguish speakers using a less resource-intensive method.

**What does this value represent?**  
The `tinydiarize` parameter activates a basic diarization algorithm, which may be faster but less accurate than full diarization.  
It is intended for scenarios where computational resources are limited or only rough speaker separation is needed.

**Note:**  
This is an alternative to the main `diarize` option and is not commonly used in most workflows.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -tdrz -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --tinydiarize -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -tdrz ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Enable tiny diarization (from CLI: -tdrz)
wparams.tinydiarize = true;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## no_fallback

### 1. Description
Disables fallback to alternative decoding strategies if the primary decoding method fails to produce a valid output.

**What does this value represent?**  
The `no_fallback` parameter, when enabled, instructs the model to not attempt fallback strategies (such as switching from beam search to greedy decoding) if the initial decoding fails.  
This is mainly useful for debugging or for strict evaluation scenarios.

**Note:**  
For most users, fallback is desirable to ensure a result is always produced. Disabling it is only recommended for advanced use cases.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -nf -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --no-fallback -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -nf ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Disable fallback (from CLI: -nf)
wparams.no_fallback = true;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## Output Format Parameters

### 1. Description
These parameters control the format in which the transcription result is saved or printed by the CLI. They do **not** affect the inference process or the model’s output, only how the results are formatted for the user.

- `output_txt`: Plain text file (`.txt`)
- `output_vtt`: WebVTT subtitle file (`.vtt`)
- `output_srt`: SubRip subtitle file (`.srt`)
- `output_wts`: Word-level timestamps file
- `output_csv`: CSV file (`.csv`)
- `output_jsn`: JSON file (`.json`)
- `output_jsn_full`: Full JSON file with extra metadata
- `output_lrc`: LRC lyrics file (`.lrc`)

**What do these values represent?**  
Each flag tells the CLI to generate the transcription output in a specific file format.  
You can enable multiple formats at once to generate several output files for the same transcription.

**Note:**  
These parameters are only relevant for CLI usage. In an AddOn or API, output formatting is typically handled separately in the application layer.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -otxt -osrt -ocsv -oj -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --output-txt --output-srt --output-csv --output-json -m models/ggml-base.en.bin -f audio.wav
```
*(This will generate `.txt`, `.srt`, `.csv`, and `.json` files for the same audio input.)*

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -otxt -osrt -ocsv -oj ...`

// 1. Set output flags (for CLI output only)
bool output_txt = true;
bool output_srt = true;
bool output_csv = true;
bool output_jsn = true;

// 2. After inference, write outputs in the requested formats
if (output_txt) output_txt_function(ctx, fout, params, pcmf32s);
if (output_srt) output_srt_function(ctx, fout, params, pcmf32s);
if (output_csv) output_csv_function(ctx, fout, params, pcmf32s);
if (output_jsn) output_json_function(ctx, fout, params, pcmf32s);

// Note: These flags do not affect whisper_full_params or whisper_full().
```

---

## Output Print and Display Parameters

### 1. Description
These parameters control how the CLI displays or prints information to the console or output files. They do **not** affect the inference process or the transcription results, only the user experience and debugging output.

- `no_prints`: Disables all console prints except errors.
- `print_special`: Prints special tokens in the output.
- `print_colors`: Enables colored output in the console.
- `print_confidence`: Prints confidence scores for each word or segment.
- `print_progress`: Prints progress updates during transcription.
- `no_timestamps`: Omits timestamps in the output.
- `log_score`: Prints log-probability scores for the transcription.

**What do these values represent?**  
Each flag customizes the verbosity, formatting, or additional information shown in the CLI output.  
They are useful for debugging, monitoring, or customizing the user experience in the terminal.

**Note:**  
These parameters are only relevant for CLI usage. In an AddOn or API, such display options are typically handled by the application UI or logging system.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --no-prints --print-special --print-colors --print-confidence --print-progress --no-timestamps --log-score -m models/ggml-base.en.bin -f audio.wav
```
or with short flags:
```sh
whisper-cli -np -ps -pc -pp -nt -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs with various print/display flags

bool no_prints = true;
bool print_special = true;
bool print_colors = true;
bool print_confidence = true;
bool print_progress = true;
bool no_timestamps = true;
bool log_score = true;

// Usage in CLI (pseudo-code):
if (!no_prints) {
    if (print_special) { /* print special tokens */ }
    if (print_colors) { /* enable colored output */ }
    if (print_confidence) { /* print confidence scores */ }
    if (print_progress) { /* print progress updates */ }
    if (log_score) { /* print log-probability scores */ }
    if (no_timestamps) { /* omit timestamps in output */ }
}

// Note: These flags do not affect whisper_full_params or whisper_full().
```

---

## flash_attn

### 1. Description
Enables the use of FlashAttention, an optimized attention mechanism for transformer models that can accelerate inference and reduce memory usage on supported hardware.

**What does this value represent?**  
The `flash_attn` parameter activates FlashAttention if the model and hardware support it.  
- **Enabled:** Uses FlashAttention for faster and more memory-efficient inference.
- **Disabled:** Uses standard attention mechanism.

**Note:**  
This is an experimental feature and may not be available in all builds or on all hardware. It is mainly relevant for advanced users seeking maximum performance.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -fa -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --flash-attn -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -fa ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Enable FlashAttention (from CLI: -fa)
wparams.flash_attn = true;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## no_timestamps

### 1. Description
Omits timestamps in the transcription output. When enabled, the output will not include time markers for segments or words.

**What does this value represent?**  
The `no_timestamps` parameter is useful when you want plain text output without any timing information, for example, for subtitles or transcripts where timing is not needed.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -nt -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --no-timestamps -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -nt ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Omit timestamps in output (from CLI: -nt)
wparams.no_timestamps = true;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## log_score

### 1. Description
Enables printing of log-probability scores for the transcription. This is mainly for debugging or evaluation purposes.

**What does this value represent?**  
The `log_score` parameter, when enabled, causes the CLI to print the log-probability score of the generated transcription, which can be useful for model evaluation or debugging.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --log-score -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --log-score ...`

bool log_score = true;

// After inference, print log-probability score if flag is set
if (log_score) {
    output_score(ctx, fout, params, pcmf32s);
}

// Note: This does not affect whisper_full_params or whisper_full().
```

---

## use_gpu(👍🏼)

### 1. Description
Enables or disables GPU acceleration for inference, if supported by the build and hardware.

**What does this value represent?**  
The `use_gpu` parameter allows the model to use GPU resources for faster inference.  
- **Enabled:** Uses GPU if available.
- **Disabled:** Forces CPU-only inference.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -ng -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --no-gpu -m models/ggml-base.en.bin -f audio.wav
```
*(By default, GPU is used if available. The `-ng` or `--no-gpu` flag disables GPU usage.)*

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -ng ...` to disable GPU

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Disable GPU usage (from CLI: -ng)
wparams.use_gpu = false;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## suppress_nst(👍🏼)

### 1. Description
Enables suppression of non-speech tokens (NST) in the transcription output. When enabled, the model will attempt to filter out tokens that are not considered speech, such as background noise or filler sounds.

**What does this value represent?**  
The `suppress_nst` parameter helps to clean up the transcription by removing non-speech artifacts, which can be useful in noisy environments or for applications requiring clean text output.

**Note:**  
This is mainly useful for advanced users or in scenarios with a lot of background noise.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -sns -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --suppress-nst -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -sns ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Enable suppression of non-speech tokens (from CLI: -sns)
wparams.suppress_nst = true;

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## language(👍🏼)

### 1. Description
Specifies the language to use for transcription. If not set, the model will use automatic language detection (if enabled).

**What does this value represent?**  
The `language` parameter forces the model to transcribe the audio in a specific language, bypassing auto-detection.  
This is useful for multi-language applications or when you know the language in advance and want to avoid detection errors.

**Note:**  
The value should be an ISO 639-1 language code (e.g., "en" for English, "es" for Spanish).

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -l es -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --language es -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -l es ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the language (from CLI: -l es)
strncpy(wparams.language, "es", sizeof(wparams.language));

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## prompt

### 1. Description
Specifies an initial prompt (context) to prepend to the transcription. This can help guide the model, improve accuracy, or provide domain-specific context.

**What does this value represent?**  
The `prompt` parameter allows you to supply a string that is used as context for the model before it starts transcribing the audio.  
This is useful for specialized vocabulary, names, or phrases that are expected in the audio.

**Note:**  
The prompt should be a string relevant to the expected content of the audio.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --prompt "Welcome to the QVAC conference" -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --prompt "Welcome to the QVAC conference" ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the initial prompt (from CLI: --prompt "Welcome to the QVAC conference")
strncpy(wparams.prompt, "Welcome to the QVAC conference", sizeof(wparams.prompt));

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## model(👍🏼)

### 1. Description
Specifies the path to the Whisper model file to be used for transcription.

**What does this value represent?**  
The `model` parameter tells whisper.cpp which model weights to load for inference.  
This is fundamental for selecting the model size, language, and quantization (e.g., tiny, base, small, medium, large, or quantized variants).

**Note:**  
The model file must be in the GGML format supported by whisper.cpp (e.g., `ggml-base.en.bin`).

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli --model models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -m models/ggml-base.en.bin ...`

// 1. Load the model from the specified path
struct whisper_context * ctx = whisper_init_from_file("models/ggml-base.en.bin");

// 2. Use ctx in all subsequent inference calls
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## grammar

### 1. Description
Specifies the path to a custom grammar file (in GBNF format) to constrain the transcription output according to specific rules.

**What does this value represent?**  
The `grammar` parameter allows you to provide a grammar file that defines valid output structures for the transcription.  
This is useful for applications requiring strict output formats, such as command recognition or structured data extraction.

**Note:**  
The grammar file must be in the GBNF (Grammar-Based Notation Format) supported by whisper.cpp.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --grammar grammars/commands.gbnf -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --grammar grammars/commands.gbnf ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the grammar file path (from CLI: --grammar ...)
strncpy(wparams.grammar, "grammars/commands.gbnf", sizeof(wparams.grammar));

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## grammar_rule

### 1. Description
Specifies the entry rule to use from the provided grammar file (GBNF) for constrained transcription.

**What does this value represent?**  
The `grammar_rule` parameter allows you to select a specific rule as the starting point when using a custom grammar file.  
This is useful when your grammar file defines multiple possible entry points for different tasks or output formats.

**Note:**  
This parameter is only relevant if a grammar file is provided via the `grammar` parameter.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --grammar grammars/commands.gbnf --grammar-rule "main_rule" -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --grammar-rule "main_rule" ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the grammar rule (from CLI: --grammar-rule "main_rule")
strncpy(wparams.grammar_rule, "main_rule", sizeof(wparams.grammar_rule));

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## suppress_regex

### 1. Description
Specifies a regular expression pattern to suppress (ignore) certain tokens in the transcription output.

**What does this value represent?**  
The `suppress_regex` parameter allows you to define a regex pattern. Any tokens matching this pattern will be excluded from the final transcript.  
This is useful for filtering out unwanted words, phrases, or noise artifacts automatically.

**Note:**  
This is an advanced feature, mainly for specialized use cases or post-processing.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --suppress-regex "[0-9]+" -m models/ggml-base.en.bin -f audio.wav
```
*(This would suppress any numeric tokens in the output.)*

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --suppress-regex "[0-9]+" ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the suppress regex pattern (from CLI: --suppress-regex "[0-9]+")
strncpy(wparams.suppress_regex, "[0-9]+", sizeof(wparams.suppress_regex));

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## openvino_encode_device

### 1. Description
Specifies the device to use for OpenVINO-accelerated inference (e.g., "CPU", "GPU", "MYRIAD"). This is only relevant if whisper.cpp was built with OpenVINO support.

**What does this value represent?**  
The `openvino_encode_device` parameter allows you to select which hardware device OpenVINO should use for model inference.  
This is useful for optimizing performance on systems with multiple supported devices.

**Note:**  
This parameter is only effective if OpenVINO is enabled in your build and hardware supports it.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --ov-e-device GPU -m models/ggml-base.en.bin -f audio.wav
```
or
```sh
whisper-cli -oved GPU -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --ov-e-device GPU ...`

// 1. Create default parameters
whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

// 2. Set the OpenVINO device (from CLI: --ov-e-device GPU)
strncpy(wparams.openvino_encode_device, "GPU", sizeof(wparams.openvino_encode_device));

// 3. Run inference
whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
```

---

## fname_inp

### 1. Description
Specifies the input audio file(s) to be transcribed. This parameter is used by the CLI to load audio data for processing.

**What does this value represent?**  
The `fname_inp` parameter is a list of file paths to audio files that will be transcribed by whisper.cpp.  
It is only relevant for CLI usage, as API or AddOn integrations typically receive audio data directly (not via file paths).

**Note:**  
Multiple files can be specified for batch processing in the CLI.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli -f audio1.wav audio2.wav -m models/ggml-base.en.bin
```
or simply
```sh
whisper-cli audio1.wav audio2.wav -m models/ggml-base.en.bin
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli -f audio1.wav audio2.wav ...`

// 1. Collect input file names from CLI arguments
std::vector<std::string> fname_inp = {"audio1.wav", "audio2.wav"};

// 2. For each file, load audio data and run inference
for (const auto& file : fname_inp) {
    std::vector<float> pcmf32 = load_audio_file(file);
    whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size());
}
```

---

## vad(👍🏼)

### 1. Description
Enables Voice Activity Detection (VAD), which automatically detects and segments regions of speech in the audio before transcription.

**What does this value represent?**  
The `vad` parameter tells whisper.cpp to use a VAD model to split the audio into speech and non-speech segments. Only the detected speech segments are transcribed, which is useful for long recordings or noisy environments.

**Note:**  
VAD requires a separate VAD model file and uses dedicated VAD API functions.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --vad --vad-model models/for-tests-silero-v5.1.2-ggml.bin -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --vad --vad-model models/for-tests-silero-v5.1.2-ggml.bin ...`

// 1. Set up VAD context parameters
struct whisper_vad_context_params ctx_params = whisper_vad_default_context_params();
ctx_params.n_threads = 4; // or user-specified
ctx_params.use_gpu = false; // or true if supported

// 2. Initialize the VAD context with the VAD model
struct whisper_vad_context * vctx = whisper_vad_init_from_file_with_params(
    "models/for-tests-silero-v5.1.2-ggml.bin", ctx_params);

// 3. Set up VAD parameters
struct whisper_vad_params vad_params = whisper_vad_default_params();
vad_params.threshold = 0.5f; // or user-specified
vad_params.min_speech_duration_ms = 250;
vad_params.min_silence_duration_ms = 100;
vad_params.max_speech_duration_s = FLT_MAX;
vad_params.speech_pad_ms = 30;
vad_params.samples_overlap = 0.1f;

// 4. Run VAD to detect speech segments
bool ok = whisper_vad_detect_speech(vctx, pcmf32.data(), pcmf32.size());

// 5. Get the speech segments
struct whisper_vad_segments * segments = whisper_vad_segments_from_probs(vctx, vad_params);
int n_segments = whisper_vad_segments_n_segments(segments);

for (int i = 0; i < n_segments; ++i) {
    float t0 = whisper_vad_segments_get_segment_t0(segments, i);
    float t1 = whisper_vad_segments_get_segment_t1(segments, i);
    // Process or transcribe each segment [t0, t1]
}

// 6. Free resources
whisper_vad_free_segments(segments);
whisper_vad_free(vctx);
```

---

## vad_model

### 1. Description
Specifies the path to the VAD (Voice Activity Detection) model file to be used for speech segmentation.

**What does this value represent?**  
The `vad_model` parameter tells whisper.cpp which VAD model weights to load for detecting speech segments.  
This is required for enabling VAD and must point to a compatible VAD model file (e.g., Silero VAD in GGML format).

**Note:**  
The VAD model is separate from the main Whisper model and must be downloaded or converted separately.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --vad --vad-model models/for-tests-silero-v5.1.2-ggml.bin -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --vad-model models/for-tests-silero-v5.1.2-ggml.bin ...`

// 1. Set up VAD context parameters
struct whisper_vad_context_params ctx_params = whisper_vad_default_context_params();

// 2. Initialize the VAD context with the specified VAD model
struct whisper_vad_context * vctx = whisper_vad_init_from_file_with_params(
    "models/for-tests-silero-v5.1.2-ggml.bin", ctx_params);

// 3. Use vctx for VAD operations as shown in the previous example
```

---

## vad_threshold(👍🏼)

### 1. Description
Sets the probability threshold for classifying a segment as speech in Voice Activity Detection (VAD).

**What does this value represent?**  
The `vad_threshold` parameter determines how confident the VAD model must be to classify a segment as speech.  
- **Lower values** (e.g., 0.3): More segments are classified as speech (more sensitive).
- **Higher values** (e.g., 0.7): Only high-confidence segments are classified as speech (less sensitive).

**Note:**  
Tuning this value helps balance between missing quiet speech and including noise.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --vad --vad-threshold 0.6 --vad-model models/for-tests-silero-v5.1.2-ggml.bin -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --vad-threshold 0.6 ...`

// 1. Set up VAD parameters
struct whisper_vad_params vad_params = whisper_vad_default_params();
vad_params.threshold = 0.6f;

// 2. Use vad_params in VAD segment detection
struct whisper_vad_segments * segments = whisper_vad_segments_from_probs(vctx, vad_params);
```

---

## vad_min_speech_duration_ms(👍🏼)

### 1. Description
Sets the minimum duration (in milliseconds) for a segment to be considered valid speech in Voice Activity Detection (VAD).

**What does this value represent?**  
The `vad_min_speech_duration_ms` parameter filters out very short speech segments that may be noise or artifacts.  
- **Lower values** (e.g., 50): Allows shorter speech segments.
- **Higher values** (e.g., 500): Only longer speech segments are accepted.

**Note:**  
This helps reduce false positives from brief noises or very short utterances.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --vad --vad-min-speech-duration-ms 300 --vad-model models/for-tests-silero-v5.1.2-ggml.bin -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --vad-min-speech-duration-ms 300 ...`

// 1. Set up VAD parameters
struct whisper_vad_params vad_params = whisper_vad_default_params();
vad_params.min_speech_duration_ms = 300;

// 2. Use vad_params in VAD segment detection
struct whisper_vad_segments * segments = whisper_vad_segments_from_probs(vctx, vad_params);
```

---

## vad_min_silence_duration_ms(👍🏼)

### 1. Description
Sets the minimum duration (in milliseconds) of silence required to split speech segments in Voice Activity Detection (VAD).

**What does this value represent?**  
The `vad_min_silence_duration_ms` parameter determines how long a pause must be to be considered a true silence and used to split speech into separate segments.  
- **Lower values** (e.g., 50): Short pauses will split segments more frequently.
- **Higher values** (e.g., 500): Only longer silences will split segments.

**Note:**  
Tuning this value helps control how sensitive the segmentation is to brief pauses in speech.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --vad --vad-min-silence-duration-ms 200 --vad-model models/for-tests-silero-v5.1.2-ggml.bin -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --vad-min-silence-duration-ms 200 ...`

// 1. Set up VAD parameters
struct whisper_vad_params vad_params = whisper_vad_default_params();
vad_params.min_silence_duration_ms = 200;

// 2. Use vad_params in VAD segment detection
struct whisper_vad_segments * segments = whisper_vad_segments_from_probs(vctx, vad_params);
```

---

## vad_speech_pad_ms(👍🏼)

### 1. Description
Sets the amount of padding (in milliseconds) to add before and after each detected speech segment in Voice Activity Detection (VAD).

**What does this value represent?**  
The `vad_speech_pad_ms` parameter adds extra context to each speech segment by including a small amount of audio before and after the detected speech.  
- **Lower values** (e.g., 0): No padding.
- **Higher values** (e.g., 100): Adds more context, which can help avoid cutting off words at segment boundaries.

**Note:**  
Padding is useful for smoother transitions and more natural segment boundaries.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --vad --vad-speech-pad-ms 50 --vad-model models/for-tests-silero-v5.1.2-ggml.bin -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --vad-speech-pad-ms 50 ...`

// 1. Set up VAD parameters
struct whisper_vad_params vad_params = whisper_vad_default_params();
vad_params.speech_pad_ms = 50;

// 2. Use vad_params in VAD segment detection
struct whisper_vad_segments * segments = whisper_vad_segments_from_probs(vctx, vad_params);
```

---

## vad_samples_overlap

### 1. Description
Sets the overlap (as a fraction of a second, e.g., 0.1 = 100ms) between consecutive speech segments in Voice Activity Detection (VAD).

**What does this value represent?**  
The `vad_samples_overlap` parameter ensures that adjacent speech segments overlap by a certain amount, which helps avoid cutting off words at segment boundaries and provides smoother transitions.  
- **Lower values** (e.g., 0.0): No overlap.
- **Higher values** (e.g., 0.2): More overlap between segments.

**Note:**  
This is useful for applications where seamless audio or text continuity is important.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --vad --vad-samples-overlap 0.1 --vad-model models/for-tests-silero-v5.1.2-ggml.bin -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --vad-samples-overlap 0.1 ...`

// 1. Set up VAD parameters
struct whisper_vad_params vad_params = whisper_vad_default_params();
vad_params.samples_overlap = 0.1f;

// 2. Use vad_params in VAD segment detection
struct whisper_vad_segments * segments = whisper_vad_segments_from_probs(vctx, vad_params);
```

---

## vad_max_speech_duration_s(👍🏼)

### 1. Description
Sets the maximum duration (in seconds) allowed for a single speech segment in Voice Activity Detection (VAD).

**What does this value represent?**  
The `vad_max_speech_duration_s` parameter ensures that no single speech segment is longer than the specified value.  
- **Lower values** (e.g., 5): Segments longer than 5 seconds will be split.
- **Higher values** (e.g., 60): Allows longer continuous speech segments.

**Note:**  
This is useful for preventing excessively long segments, which can be hard to process, align, or display.

### 2. Example Usage in whisper.cpp (CLI)
```sh
whisper-cli --vad --vad-max-speech-duration-s 10 --vad-model models/for-tests-silero-v5.1.2-ggml.bin -m models/ggml-base.en.bin -f audio.wav
```

### 3. C++ Implementation Snippet

```cpp
// Example: User runs `whisper-cli --vad-max-speech-duration-s 10 ...`

// 1. Set up VAD parameters
struct whisper_vad_params vad_params = whisper_vad_default_params();
vad_params.max_speech_duration_s = 10.0f;

// 2. Use vad_params in VAD segment detection
struct whisper_vad_segments * segments = whisper_vad_segments_from_probs(vctx, vad_params);
```