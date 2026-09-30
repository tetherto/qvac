#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace qvac::asrggml::parakeet {

/**
 * Speaker segment from diarization (Sortformer)
 */
struct SpeakerSegment {
  float start = 0.0f;
  float end = 0.0f;
  int speakerId = -1;
};

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
  // Sortformer only. A streaming diarization segment carries its speaker
  // here (-1 on every other segment); the single offline diarization
  // transcript lists every segment in speakerSegments instead. Both mirror
  // the "Speaker N: start - end" text, which is kept for existing parsers.
  int speakerId = -1;
  std::vector<SpeakerSegment> speakerSegments;

  Transcript()
      : toAppend{false}, start(-1.0F), end(-1.0F), id{0}, isEndOfTurn{false},
        startsWord{true} {}

  explicit Transcript(std::string_view strView)
      : text{strView}, toAppend{false}, start{-1.0F}, end{-1.0F}, id{0},
        isEndOfTurn{false}, startsWord{true} {}
};

/**
 * Model types supported by Parakeet
 */
enum class ModelType : std::uint8_t {
  CTC, // English-only, fast transcription with punctuation/capitalization
  TDT, // Multilingual (~25 languages) with auto-detection
  EOU, // Real-time streaming with end-of-utterance detection
  SORTFORMER, // Speaker diarization (up to 4 speakers)
  RNNT,
  NEMOTRON // Locale-conditioned cache-aware streaming RNN-T
};

/**
 * Where a streaming voice-activity transition came from: the engine's RMS
 * energy detector (CTC / TDT / RNN-T / Nemotron) or Sortformer's speaker
 * probabilities.
 */
enum class VadSource : std::uint8_t { Energy, Sortformer };

/**
 * Voice-activity transition forwarded from a speech-cpp StreamEvent
 * (VadStateChanged). Emitted only on a state change, never per chunk.
 */
struct VadEvent {
  bool speaking = false;
  // Energy: window RMS (linear, 0..1). Sortformer: highest speaker
  // probability in the chunk.
  float score = 0.0f;
  // Seconds from the start of the streaming session.
  double timestamp = 0.0;
  // Sortformer only: dominant speaker on entering speech; -1 otherwise.
  int speakerId = -1;
  VadSource source = VadSource::Energy;
};

/**
 * Audio input for transcription
 */
struct AudioInput {
  std::vector<float> audioData; // Audio samples (normalized to [-1, 1])
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

} // namespace qvac::asrggml::parakeet
