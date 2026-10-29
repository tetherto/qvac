#pragma once

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <optional>
#include <span>
#include <stdexcept>
#include <utility>

#include <parakeet/attributed.h>

namespace qvac::asrggml::parakeet {

class AttributedTranscription {
public:
  using Diarize = std::function<::parakeet::DiarizationResult()>;
  using Transcribe = std::function<std::string(std::span<const float>)>;
  using CheckCancellation = std::function<void()>;

  AttributedTranscription(
      std::span<const float> audio, int sampleRate,
      ::parakeet::AttributedTranscriptionOptions options, Diarize diarize,
      Transcribe transcribe, CheckCancellation checkCancellation)
      : audio_(audio), sampleRate_(sampleRate), options_(options),
        diarize_(std::move(diarize)), transcribe_(std::move(transcribe)),
        checkCancellation_(std::move(checkCancellation)) {
    if (audio.empty() ||
        audio.size() > static_cast<size_t>(std::numeric_limits<int>::max()) ||
        sampleRate <= 0) {
      throw std::invalid_argument(
          "Invalid native audio buffer for speaker attribution");
    }
    if (options.min_segment_ms < 0 || options.pad_segment_ms < 0) {
      throw std::invalid_argument(
          "Speaker attribution durations must be non-negative");
    }
  }

  ::parakeet::AttributedTranscriptionResult run() {
    checkCancellation_();
    ::parakeet::AttributedTranscriptionResult result;
    result.audio_samples = static_cast<int>(audio_.size());
    result.sample_rate = sampleRate_;
    result.diarization = diarize_();
    checkCancellation_();
    transcribeTurns(result);
    return result;
  }

private:
  std::optional<std::span<const float>>
  sliceFor(const ::parakeet::DiarizationSegment& segment) const {
    if (!std::isfinite(segment.start_s) || !std::isfinite(segment.end_s) ||
        segment.end_s < segment.start_s) {
      throw std::invalid_argument("Invalid native diarization timestamps");
    }
    constexpr double millisecondsPerSecond = 1000.0;
    const double duration = static_cast<double>(audio_.size()) / sampleRate_;
    const double padding = options_.pad_segment_ms / millisecondsPerSecond;
    const double start = std::clamp(segment.start_s - padding, 0.0, duration);
    const double end = std::clamp(segment.end_s + padding, 0.0, duration);
    if (end - start < options_.min_segment_ms / millisecondsPerSecond)
      return std::nullopt;
    const auto first = std::min(
        static_cast<size_t>(std::floor(start * sampleRate_)), audio_.size());
    const auto last = std::min(
        static_cast<size_t>(std::ceil(end * sampleRate_)), audio_.size());
    if (last <= first)
      return std::nullopt;
    return audio_.subspan(first, last - first);
  }

  void appendSegment(
      ::parakeet::AttributedTranscriptionResult& result,
      ::parakeet::AttributedSegment segment) const {
    if (!options_.merge_same_speaker || result.segments.empty() ||
        result.segments.back().speaker_id != segment.speaker_id) {
      result.segments.push_back(std::move(segment));
      return;
    }
    auto& previous = result.segments.back();
    if (!previous.text.empty() && !segment.text.empty())
      previous.text += ' ';
    previous.text += segment.text;
    previous.end_s = segment.end_s;
  }

  void transcribeTurns(::parakeet::AttributedTranscriptionResult& result) {
    result.segments.reserve(result.diarization.segments.size());
    for (const auto& turn : result.diarization.segments) {
      checkCancellation_();
      const auto slice = sliceFor(turn);
      if (!slice)
        continue;
      auto text = transcribe_(*slice);
      ++result.asr_calls;
      checkCancellation_();
      appendSegment(
          result, {turn.speaker_id, std::move(text), turn.start_s, turn.end_s});
    }
  }

  std::span<const float> audio_;
  int sampleRate_;
  ::parakeet::AttributedTranscriptionOptions options_;
  Diarize diarize_;
  Transcribe transcribe_;
  CheckCancellation checkCancellation_;
};

} // namespace qvac::asrggml::parakeet
