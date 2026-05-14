#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace qvac_lib_infer_parakeet {

/**
 * Transcription result segment
 */
struct Transcript {
  std::string text;
  bool toAppend;
  float start;
  float end;
  size_t id;
  // True when this segment ends on a recognised end-of-utterance boundary
  // (EOU streaming: `<EOU>` token; CTC/TDT/Sortformer always leave this
  // false). The text field still carries any speech tokens decoded in the
  // same chunk; consumers that want a turn-end signal independent of the
  // transcript should test this flag.
  bool isEndOfTurn;
  // True when this segment's first token is a SentencePiece word-start
  // (the piece begins with the `▁` U+2581 marker), false when it is a
  // wordpiece continuation of the previous segment's last token.
  // Streaming consumers building a running transcript should insert a
  // separator (e.g. " ") between successive segments only when the
  // *new* segment has `startsWord == true`. Concatenating verbatim when
  // `startsWord == false` rejoins chunk-boundary splits like
  // ["pun", "ctuation"] into "punctuation"; inserting a space there
  // would yield "pun ctuation" instead. Always true on the very first
  // segment of a session, on Sortformer segments (the diarization
  // engine doesn't surface tokens), and on any segment whose token list
  // is empty (defensive default).
  bool startsWord;

  Transcript()
      : toAppend{false},
        start(-1.0F),
        end(-1.0F),
        id{0},
        isEndOfTurn{false},
        startsWord{true} {}

  explicit Transcript(std::string_view strView)
      : text{strView},
        toAppend{false},
        start{-1.0F},
        end{-1.0F},
        id{0},
        isEndOfTurn{false},
        startsWord{true} {}
};

/**
 * Model types supported by Parakeet
 */
enum class ModelType : std::uint8_t {
  CTC,        // English-only, fast transcription with punctuation/capitalization
  TDT,        // Multilingual (~25 languages) with auto-detection
  EOU,        // Real-time streaming with end-of-utterance detection
  SORTFORMER  // Speaker diarization (up to 4 speakers)
};

/**
 * Audio input for transcription
 */
struct AudioInput {
  std::vector<float> audioData;  // Audio samples (normalized to [-1, 1])
  int sampleRate = 16000;
  int channels = 1;
};

/**
 * Transcription result
 */
struct TranscriptionResult {
  std::string text;
  float confidence = 0.0f;
  bool isFinal = true;

  // Optional diarization info
  int speakerId = -1;
  float startTime = 0.0f;
  float endTime = 0.0f;
};

/**
 * Speaker segment from diarization (Sortformer)
 */
struct SpeakerSegment {
  float start = 0.0f;
  float end = 0.0f;
  int speakerId = -1;
};

/**
 * Configuration for Sortformer post-processing.
 * Pre-tuned for CallHome dataset (NVIDIA defaults).
 */
struct DiarizationConfig {
  float onset = 0.641f;
  float offset = 0.561f;
  float padOnset = 0.229f;
  float padOffset = 0.079f;
  float minDurationOn = 0.511f;
  float minDurationOff = 0.296f;
  int medianWindow = 11;
};

} // namespace qvac_lib_infer_parakeet

