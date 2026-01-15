#include "TashkeelDiacritizer.hpp"

#include <algorithm>
#include <codecvt>
#include <fstream>
#include <locale>
#include <sstream>
#include <stdexcept>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"

// Simple JSON parsing for our use case (maps only)
#include <regex>

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac::ttslib::tashkeel {

// Arabic diacritics (harakat) - Unicode codepoints
const std::unordered_set<char32_t> TashkeelDiacritizer::ARABIC_DIACRITICS = {
    0x0652, // Sukoon
    0x0651, // Shadda
    0x064E, // Fatha
    0x064F, // Damma
    0x0650, // Kasra
    0x064B, // Fathatan
    0x064C, // Dammatan
    0x064D  // Kasratan
};

const std::unordered_set<char32_t> TashkeelDiacritizer::HARAKAT_CHARS = {
    0x064C, // Dammatan
    0x064D, // Kasratan
    0x064E, // Fatha
    0x064F, // Damma
    0x0650, // Kasra
    0x0651, // Shadda
    0x0652  // Sukoon
};

const std::unordered_set<char32_t> TashkeelDiacritizer::NUMERALS = {
    U'0', U'1', U'2', U'3', U'4', U'5', U'6', U'7', U'8', U'9', 0x0660, 0x0661,
    0x0662, 0x0663, 0x0664, // Arabic-Indic
                            // numerals
    0x0665, 0x0666, 0x0667, 0x0668, 0x0669};

TashkeelDiacritizer::TashkeelDiacritizer() {
  // Initialize diacritic normalization map
  // These are combined shadda + vowel marks that need normalization
  normalizedDiacMap_[U"\u064E\u0651"] = U"\u064E\u0651"; // Fatha + Shadda
  normalizedDiacMap_[U"\u064B\u0651"] = U"\u064B\u0651"; // Fathatan + Shadda
  normalizedDiacMap_[U"\u064F\u0651"] = U"\u064F\u0651"; // Damma + Shadda
  normalizedDiacMap_[U"\u064C\u0651"] = U"\u064C\u0651"; // Dammatan + Shadda
  normalizedDiacMap_[U"\u0650\u0651"] = U"\u0650\u0651"; // Kasra + Shadda
  normalizedDiacMap_[U"\u064D\u0651"] = U"\u064D\u0651"; // Kasratan + Shadda
}

TashkeelDiacritizer::~TashkeelDiacritizer() = default;

bool TashkeelDiacritizer::initialize(const std::string &modelDir) {
  try {
    // Load JSON maps
    if (!loadInputIdMap(modelDir + "/input_id_map.json")) {
      QLOG(Priority::ERROR, "Failed to load input_id_map.json");
      return false;
    }
    if (!loadTargetIdMap(modelDir + "/target_id_map.json")) {
      QLOG(Priority::ERROR, "Failed to load target_id_map.json");
      return false;
    }
    if (!loadHintIdMap(modelDir + "/hint_id_map.json")) {
      QLOG(Priority::ERROR, "Failed to load hint_id_map.json");
      return false;
    }

    // Initialize ONNX Runtime
    env_ = std::make_unique<Ort::Env>(ORT_LOGGING_LEVEL_WARNING,
                                      "TashkeelDiacritizer");

    Ort::SessionOptions sessionOptions;
    sessionOptions.SetGraphOptimizationLevel(
        GraphOptimizationLevel::ORT_ENABLE_EXTENDED);

    std::string modelPath = modelDir + "/model.onnx";
#ifdef _WIN32
    // On Windows, ONNX Runtime expects wide string (wchar_t*) for file paths
    std::wstring wModelPath(modelPath.begin(), modelPath.end());
    session_ = std::make_unique<Ort::Session>(*env_, wModelPath.c_str(),
                                              sessionOptions);
#else
    session_ = std::make_unique<Ort::Session>(*env_, modelPath.c_str(),
                                              sessionOptions);
#endif

    memoryInfo_ =
        Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

    initialized_ = true;
    QLOG(Priority::INFO, "TashkeelDiacritizer initialized successfully");
    return true;

  } catch (const Ort::Exception &e) {
    QLOG(Priority::ERROR, "ONNX Runtime error: " + std::string(e.what()));
    return false;
  } catch (const std::exception &e) {
    QLOG(Priority::ERROR,
         "Error initializing TashkeelDiacritizer: " + std::string(e.what()));
    return false;
  }
}

// Simple JSON parser for our character maps
namespace {
std::unordered_map<std::string, int> parseJsonMap(const std::string &json) {
  std::unordered_map<std::string, int> result;

  // Remove whitespace and braces
  std::string content = json;
  content.erase(std::remove_if(content.begin(), content.end(),
                               [](char c) {
                                 return c == '{' || c == '}' || c == '\n' ||
                                        c == '\r';
                               }),
                content.end());

  // Split by comma and parse key-value pairs
  // Pattern matches: "key": value (e.g., "ا": 24)
  std::regex pairRegex("\"([^\"]*)\":\\s*(\\d+)");
  std::smatch match;
  std::string::const_iterator searchStart(content.cbegin());

  while (std::regex_search(searchStart, content.cend(), match, pairRegex)) {
    std::string key = match[1].str();
    int value = std::stoi(match[2].str());
    result[key] = value;
    searchStart = match.suffix().first;
  }

  return result;
}
} // namespace

bool TashkeelDiacritizer::loadInputIdMap(const std::string &path) {
  std::ifstream file(path);
  if (!file.is_open())
    return false;

  std::stringstream buffer;
  buffer << file.rdbuf();

  auto strMap = parseJsonMap(buffer.str());
  for (const auto &[key, value] : strMap) {
    std::u32string u32key = utf8ToUtf32(key);
    if (!u32key.empty()) {
      inputIdMap_[u32key[0]] = value;
    } else if (key == "_") {
      inputIdMap_[U'_'] = value;
    }
  }

  return true;
}

bool TashkeelDiacritizer::loadTargetIdMap(const std::string &path) {
  std::ifstream file(path);
  if (!file.is_open())
    return false;

  std::stringstream buffer;
  buffer << file.rdbuf();

  auto strMap = parseJsonMap(buffer.str());
  for (const auto &[key, value] : strMap) {
    std::u32string u32key = utf8ToUtf32(key);
    idTargetMap_[value] = u32key;

    // Track meta characters (padding)
    if (key == "_") {
      targetIdMetaChars_.insert(value);
    }
  }

  return true;
}

bool TashkeelDiacritizer::loadHintIdMap(const std::string &path) {
  std::ifstream file(path);
  if (!file.is_open())
    return false;

  std::stringstream buffer;
  buffer << file.rdbuf();

  auto strMap = parseJsonMap(buffer.str());
  for (const auto &[key, value] : strMap) {
    std::u32string u32key = utf8ToUtf32(key);
    hintIdMap_[u32key] = value;
  }

  return true;
}

bool TashkeelDiacritizer::isDiacriticChar(char32_t c) {
  return ARABIC_DIACRITICS.find(c) != ARABIC_DIACRITICS.end();
}

bool TashkeelDiacritizer::isNumeral(char32_t c) {
  return NUMERALS.find(c) != NUMERALS.end();
}

std::u32string TashkeelDiacritizer::utf8ToUtf32(const std::string &utf8) {
  std::u32string result;
  size_t i = 0;
  while (i < utf8.size()) {
    char32_t codepoint = 0;
    unsigned char c = utf8[i];

    if ((c & 0x80) == 0) {
      // 1-byte (ASCII)
      codepoint = c;
      i += 1;
    } else if ((c & 0xE0) == 0xC0) {
      // 2-byte
      codepoint = (c & 0x1F) << 6;
      if (i + 1 < utf8.size()) {
        codepoint |= (utf8[i + 1] & 0x3F);
      }
      i += 2;
    } else if ((c & 0xF0) == 0xE0) {
      // 3-byte
      codepoint = (c & 0x0F) << 12;
      if (i + 1 < utf8.size()) {
        codepoint |= (utf8[i + 1] & 0x3F) << 6;
      }
      if (i + 2 < utf8.size()) {
        codepoint |= (utf8[i + 2] & 0x3F);
      }
      i += 3;
    } else if ((c & 0xF8) == 0xF0) {
      // 4-byte
      codepoint = (c & 0x07) << 18;
      if (i + 1 < utf8.size()) {
        codepoint |= (utf8[i + 1] & 0x3F) << 12;
      }
      if (i + 2 < utf8.size()) {
        codepoint |= (utf8[i + 2] & 0x3F) << 6;
      }
      if (i + 3 < utf8.size()) {
        codepoint |= (utf8[i + 3] & 0x3F);
      }
      i += 4;
    } else {
      i += 1; // Invalid, skip
    }

    result += codepoint;
  }
  return result;
}

std::string TashkeelDiacritizer::utf32ToUtf8(const std::u32string &utf32) {
  std::string result;
  for (char32_t c : utf32) {
    result += utf32CharToUtf8(c);
  }
  return result;
}

std::string TashkeelDiacritizer::utf32CharToUtf8(char32_t c) {
  std::string result;
  if (c < 0x80) {
    result += static_cast<char>(c);
  } else if (c < 0x800) {
    result += static_cast<char>(0xC0 | (c >> 6));
    result += static_cast<char>(0x80 | (c & 0x3F));
  } else if (c < 0x10000) {
    result += static_cast<char>(0xE0 | (c >> 12));
    result += static_cast<char>(0x80 | ((c >> 6) & 0x3F));
    result += static_cast<char>(0x80 | (c & 0x3F));
  } else {
    result += static_cast<char>(0xF0 | (c >> 18));
    result += static_cast<char>(0x80 | ((c >> 12) & 0x3F));
    result += static_cast<char>(0x80 | ((c >> 6) & 0x3F));
    result += static_cast<char>(0x80 | (c & 0x3F));
  }
  return result;
}

std::pair<std::u32string, std::unordered_set<char32_t>>
TashkeelDiacritizer::toValidChars(const std::u32string &text) {
  std::u32string valid;
  std::unordered_set<char32_t> invalid;

  for (char32_t c : text) {
    if (inputIdMap_.find(c) != inputIdMap_.end() || isDiacriticChar(c)) {
      valid += c;
    } else if (isNumeral(c)) {
      valid += NUMERAL_SYMBOL;
    } else {
      invalid.insert(c);
    }
  }

  return {valid, invalid};
}

std::pair<std::u32string, std::vector<std::u32string>>
TashkeelDiacritizer::extractCharsAndDiacritics(const std::u32string &text,
                                               bool normalizeDiacritics) {
  // Strip leading diacritics
  std::u32string stripped = text;
  while (!stripped.empty() && isDiacriticChar(stripped[0])) {
    stripped = stripped.substr(1);
  }

  std::u32string cleanChars;
  std::vector<std::u32string> diacritics;
  std::u32string pendingDiac;

  // Add trailing space to emulate Rust's .chain(iter::once(' '))
  std::u32string textWithSpace = stripped + U" ";

  for (char32_t c : textWithSpace) {
    if (isDiacriticChar(c)) {
      pendingDiac += c;
    } else {
      cleanChars += c;
      diacritics.push_back(pendingDiac);
      pendingDiac.clear();
    }
  }

  // Pop the trailing space equivalent
  if (!cleanChars.empty()) {
    cleanChars.pop_back();
  }
  // Remove initial empty diacritic
  if (!diacritics.empty()) {
    diacritics.erase(diacritics.begin());
  }

  // Normalize diacritics if requested
  if (normalizeDiacritics) {
    for (auto &d : diacritics) {
      if (hintIdMap_.find(d) == hintIdMap_.end()) {
        auto it = normalizedDiacMap_.find(d);
        if (it != normalizedDiacMap_.end()) {
          d = it->second;
        } else {
          d.clear();
        }
      }
    }
  }

  return {cleanChars, diacritics};
}

std::vector<int64_t>
TashkeelDiacritizer::inputToIds(const std::u32string &text) {
  std::vector<int64_t> ids;
  ids.reserve(text.size());

  for (char32_t c : text) {
    auto it = inputIdMap_.find(c);
    if (it != inputIdMap_.end()) {
      ids.push_back(it->second);
    } else {
      // Unknown character, use padding
      ids.push_back(0);
    }
  }

  return ids;
}

std::vector<int64_t>
TashkeelDiacritizer::hintToIds(const std::vector<std::u32string> &diacritics) {
  std::vector<int64_t> ids;
  ids.reserve(diacritics.size());

  for (const auto &d : diacritics) {
    auto it = hintIdMap_.find(d);
    if (it != hintIdMap_.end()) {
      ids.push_back(it->second);
    } else {
      // Unknown diacritic, use empty (1)
      ids.push_back(1);
    }
  }

  return ids;
}

std::vector<std::u32string>
TashkeelDiacritizer::targetToDiacritics(const std::vector<uint8_t> &targetIds) {
  std::vector<std::u32string> diacritics;
  diacritics.reserve(targetIds.size());

  for (uint8_t id : targetIds) {
    if (targetIdMetaChars_.find(id) == targetIdMetaChars_.end()) {
      auto it = idTargetMap_.find(id);
      if (it != idTargetMap_.end()) {
        diacritics.push_back(it->second);
      } else {
        diacritics.push_back(U"");
      }
    }
  }

  return diacritics;
}

std::pair<std::vector<uint8_t>, std::vector<float>>
TashkeelDiacritizer::infer(const std::vector<int64_t> &inputIds,
                           const std::vector<int64_t> &diacIds,
                           int64_t seqLength) {
  // Prepare input tensors
  std::array<int64_t, 2> inputShape = {1, seqLength};
  std::array<int64_t, 1> lengthShape = {1};

  std::vector<int64_t> inputLengths = {seqLength};

  Ort::Value charInputsTensor = Ort::Value::CreateTensor<int64_t>(
      memoryInfo_, const_cast<int64_t *>(inputIds.data()), inputIds.size(),
      inputShape.data(), inputShape.size());

  Ort::Value diacInputsTensor = Ort::Value::CreateTensor<int64_t>(
      memoryInfo_, const_cast<int64_t *>(diacIds.data()), diacIds.size(),
      inputShape.data(), inputShape.size());

  Ort::Value inputLengthsTensor = Ort::Value::CreateTensor<int64_t>(
      memoryInfo_, inputLengths.data(), inputLengths.size(), lengthShape.data(),
      lengthShape.size());

  // Get input names from the model
  Ort::AllocatorWithDefaultOptions allocator;
  std::vector<const char *> inputNames;
  std::vector<std::string> inputNameStrings;
  size_t numInputs = session_->GetInputCount();
  for (size_t i = 0; i < numInputs; i++) {
    auto name = session_->GetInputNameAllocated(i, allocator);
    inputNameStrings.push_back(name.get());
  }
  for (const auto &name : inputNameStrings) {
    inputNames.push_back(name.c_str());
  }

  // Get output names from the model
  std::vector<const char *> outputNames;
  std::vector<std::string> outputNameStrings;
  size_t numOutputs = session_->GetOutputCount();
  for (size_t i = 0; i < numOutputs; i++) {
    auto name = session_->GetOutputNameAllocated(i, allocator);
    outputNameStrings.push_back(name.get());
  }
  for (const auto &name : outputNameStrings) {
    outputNames.push_back(name.c_str());
  }

  std::vector<Ort::Value> inputTensors;
  inputTensors.push_back(std::move(charInputsTensor));
  inputTensors.push_back(std::move(diacInputsTensor));
  inputTensors.push_back(std::move(inputLengthsTensor));

  // Run inference
  auto outputs = session_->Run(Ort::RunOptions{nullptr}, inputNames.data(),
                               inputTensors.data(), inputTensors.size(),
                               outputNames.data(), outputNames.size());

  // Extract outputs
  // Output 0: target_ids (uint8)
  auto *targetIdsData = outputs[0].GetTensorMutableData<uint8_t>();
  auto targetIdsShape = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
  size_t targetIdsSize = 1;
  for (auto dim : targetIdsShape)
    targetIdsSize *= dim;
  std::vector<uint8_t> targetIds(targetIdsData, targetIdsData + targetIdsSize);

  // Output 1: logits (float32)
  auto *logitsData = outputs[1].GetTensorMutableData<float>();
  auto logitsShape = outputs[1].GetTensorTypeAndShapeInfo().GetShape();
  size_t logitsSize = 1;
  for (auto dim : logitsShape)
    logitsSize *= dim;
  std::vector<float> logits(logitsData, logitsData + logitsSize);

  return {targetIds, logits};
}

std::string TashkeelDiacritizer::annotateTextWithDiacritics(
    const std::u32string &inputText,
    const std::vector<std::u32string> &diacritics,
    const std::unordered_set<char32_t> &removedChars) {

  std::u32string output;
  auto diacIt = diacritics.begin();

  for (char32_t c : inputText) {
    if (isDiacriticChar(c)) {
      continue;
    }

    if (removedChars.find(c) != removedChars.end()) {
      output += c;
    } else {
      output += c;
      if (diacIt != diacritics.end()) {
        output += *diacIt;
        ++diacIt;
      }
    }
  }

  return utf32ToUtf8(output);
}

std::string TashkeelDiacritizer::annotateTextWithDiacriticsTaskeen(
    const std::u32string &inputText,
    const std::vector<std::u32string> &diacritics,
    const std::unordered_set<char32_t> &removedChars,
    const std::vector<float> &logits, float threshold) {

  std::u32string output;
  size_t idx = 0;

  for (char32_t c : inputText) {
    if (isDiacriticChar(c)) {
      continue;
    }

    if (removedChars.find(c) != removedChars.end()) {
      output += c;
    } else {
      output += c;
      if (idx < diacritics.size() && idx < logits.size()) {
        if (logits[idx] > threshold) {
          output += SUKOON;
        } else {
          output += diacritics[idx];
        }
      }
      ++idx;
    }
  }

  return utf32ToUtf8(output);
}

std::string
TashkeelDiacritizer::diacritize(const std::string &text,
                                std::optional<float> taskeen_threshold) {
  if (!initialized_) {
    QLOG(Priority::WARNING,
         "TashkeelDiacritizer not initialized, returning original text");
    return text;
  }

  // Trim whitespace
  std::string trimmed = text;
  trimmed.erase(0, trimmed.find_first_not_of(" \t\n\r"));
  trimmed.erase(trimmed.find_last_not_of(" \t\n\r") + 1);

  if (trimmed.empty()) {
    return text;
  }

  // Convert to UTF-32 for processing
  std::u32string u32text = utf8ToUtf32(trimmed);

  if (u32text.size() > CHAR_LIMIT) {
    QLOG(Priority::ERROR,
         "Text length exceeds limit of " + std::to_string(CHAR_LIMIT));
    return text;
  }

  // Preprocess
  auto [inputText, removedChars] = toValidChars(u32text);
  auto [cleanText, diacritics] = extractCharsAndDiacritics(inputText, true);

  auto inputIds = inputToIds(cleanText);
  auto diacIds = hintToIds(diacritics);
  int64_t seqLength = static_cast<int64_t>(inputIds.size());

  if (seqLength == 0) {
    return text;
  }

  // Run inference
  auto [targetIds, logits] = infer(inputIds, diacIds, seqLength);

  // Convert target IDs to diacritics
  auto outputDiacritics = targetToDiacritics(targetIds);

  // Annotate text
  if (!taskeen_threshold.has_value()) {
    return annotateTextWithDiacritics(u32text, outputDiacritics, removedChars);
  }

  return annotateTextWithDiacriticsTaskeen(u32text, outputDiacritics,
                                           removedChars, logits,
                                           taskeen_threshold.value());
}

} // namespace qvac::ttslib::tashkeel
