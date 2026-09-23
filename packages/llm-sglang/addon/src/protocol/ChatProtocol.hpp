#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace qvac_llm_sglang {

enum class MediaKind { None, Image, Audio, Video };

struct ContentPart {
  std::string text;
  MediaKind media = MediaKind::None;
  std::vector<std::uint8_t> bytes;
  std::string path;
};

struct ChatTurn {
  std::string role;
  std::vector<ContentPart> parts;
};

struct SamplingParams {
  std::optional<double> temperature;
  std::optional<double> topP;
  std::optional<int> topK;
  std::optional<int> maxTokens;
  std::optional<int> seed;
  std::optional<double> frequencyPenalty;
  std::optional<double> presencePenalty;
  std::optional<double> repetitionPenalty;
  std::optional<std::string> jsonSchema;
  std::optional<std::string> grammar;
};

/// OpenAI chat-completions body. Throws std::invalid_argument for an empty
/// message list and for audio or video parts.
std::string buildChatBody(
    const std::vector<ChatTurn>& messages, const SamplingParams& sampling);

/// Incremental parser for `text/event-stream` chat chunks. `feed` returns the
/// new `delta.content` strings completed by this chunk. A server error event
/// throws std::runtime_error carrying the server message.
class SseParser {
 public:
  std::vector<std::string> feed(std::string_view chunk);
  [[nodiscard]] bool done() const { return done_; }

 private:
  std::string buffer_;
  bool done_ = false;

  std::vector<std::string> consumeLine(std::string_view line);
};

/// Decode one JSON string that starts at the first character inside the
/// quotes. `cursor` is the index of the opening quote.
std::string decodeJsonString(std::string_view json, std::size_t cursor);

} // namespace qvac_llm_sglang
