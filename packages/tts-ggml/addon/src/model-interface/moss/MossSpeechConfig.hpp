#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace qvac::ttsggml::moss {

struct MossSpeechConfig {
  std::string modelPath;
  std::string codecPath;
  std::optional<int> seed;
  std::optional<int> threads;
  std::optional<int> nGpuLayers;
  std::optional<bool> useGpu;
  std::string backendsDir;
};

struct MossSpeechAudio {
  std::vector<float> pcm;
  int sampleRate = 0;
};

struct MossSpeechTurn {
  std::string role;
  std::string text;
  MossSpeechAudio audio;
};

struct MossSpeechCall {
  std::vector<MossSpeechTurn> messages;
  MossSpeechAudio voice;
  bool textReply = false;
  bool greedy = false;
  std::optional<float> maxReplySeconds;
  std::optional<int> maxNewTokens;
  std::optional<float> temperature;
  std::optional<float> topP;
  std::optional<int> topK;
};

struct MossSpeechReply {
  std::vector<int16_t> pcm;
  std::string text;
};

} // namespace qvac::ttsggml::moss
