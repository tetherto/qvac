#include "SupertonicEngine.hpp"

#include "FileUtils.hpp"
#include "OrtSessionFactory.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#pragma push_macro("QLOG")
#undef QLOG
#include <qvac-onnx/OnnxConfig.hpp>
#include <qvac-onnx/OnnxSessionOptionsBuilder.hpp>
#pragma pop_macro("QLOG")

#include <utf8proc.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <optional>
#include <random>
#include <stdexcept>
#include <unordered_set>

namespace qvac::ttslib::supertonic {

namespace {

using namespace qvac_lib_inference_addon_cpp::logger;

constexpr float kMinSpeed = 0.7f;
constexpr float kMaxSpeed = 2.0f;
constexpr int kMinSteps = 1;
constexpr int kMaxSteps = 100;
constexpr float kSilenceBetweenChunksSec = 0.3f;

std::string resolvePath(const std::string &baseDir, const std::string &rel) {
  if (rel.empty())
    return baseDir;
  if (rel[0] == '/' || rel[0] == '\\' || (rel.size() >= 2 && rel[1] == ':'))
    return rel;
#ifdef _WIN32
  constexpr char sep = '\\';
  const bool trailing = !baseDir.empty() &&
                        (baseDir.back() == '/' || baseDir.back() == '\\');
#else
  constexpr char sep = '/';
  const bool trailing = !baseDir.empty() && baseDir.back() == '/';
#endif
  if (baseDir.empty())
    return rel;
  return trailing ? baseDir + rel : baseDir + sep + rel;
}

void utf8AppendCp(std::string &out, utf8proc_int32_t cp) {
  utf8proc_uint8_t buf[4];
  utf8proc_ssize_t n = utf8proc_encode_char(cp, buf);
  if (n <= 0)
    throw std::runtime_error("utf8proc_encode_char failed");
  out.append(reinterpret_cast<const char *>(buf), static_cast<size_t>(n));
}

std::optional<size_t> utf8Iterate(const std::string &s, size_t i,
                                    utf8proc_int32_t *cpOut) {
  if (i >= s.size())
    return {};
  utf8proc_int32_t cp = 0;
  utf8proc_ssize_t adv =
      utf8proc_iterate(reinterpret_cast<const utf8proc_uint8_t *>(s.data() + i),
                       static_cast<utf8proc_ssize_t>(s.size() - i), &cp);
  if (adv <= 0)
    return {};
  *cpOut = cp;
  return static_cast<size_t>(adv);
}

// Byte index of first byte of UTF-8 character that ends strictly before `pos`.
size_t utf8CharStartBefore(const std::string &s, size_t pos) {
  if (pos == 0)
    return 0;
  size_t i = pos - 1;
  while (i > 0 && (static_cast<unsigned char>(s[i]) & 0xC0) == 0x80)
    --i;
  return i;
}

bool isUnicodeWhitespace(utf8proc_int32_t cp) {
  const auto cat = utf8proc_category(cp);
  return cat == UTF8PROC_CATEGORY_ZS || cat == UTF8PROC_CATEGORY_ZL ||
         cat == UTF8PROC_CATEGORY_ZP || cp == '\t' || cp == '\n' ||
         cp == '\r' || cp == '\f' || cp == '\v';
}

bool isUnicodeWordChar(utf8proc_int32_t cp) {
  const auto c = utf8proc_category(cp);
  return (c >= UTF8PROC_CATEGORY_LU && c <= UTF8PROC_CATEGORY_LO) ||
         c == UTF8PROC_CATEGORY_ND || c == UTF8PROC_CATEGORY_NL ||
         c == UTF8PROC_CATEGORY_NO || c == UTF8PROC_CATEGORY_MC ||
         c == UTF8PROC_CATEGORY_MN;
}

void trimUtf8(std::string &s) {
  size_t b = 0;
  const size_t n = s.size();
  size_t e = n;
  while (b < e) {
    utf8proc_int32_t cp = 0;
    auto adv = utf8Iterate(s, b, &cp);
    if (!adv)
      break;
    if (!isUnicodeWhitespace(cp))
      break;
    b += *adv;
  }
  while (e > b) {
    const size_t st = utf8CharStartBefore(s, e);
    utf8proc_int32_t cp = 0;
    if (!utf8Iterate(s, st, &cp))
      break;
    if (!isUnicodeWhitespace(cp))
      break;
    e = st;
  }
  if (b > 0 || e < n)
    s = s.substr(b, e - b);
}

// `\n\s*\n+` (Python `re` / supertonic `chunk_text`), `\s` = Unicode whitespace.
std::optional<size_t> paragraphBreakEnd(const std::string &text, size_t i) {
  if (i >= text.size() || text[i] != '\n')
    return {};
  size_t j = i + 1;
  while (j < text.size() && text[j] != '\n') {
    utf8proc_int32_t cp = 0;
    auto adv = utf8Iterate(text, j, &cp);
    if (!adv)
      return {};
    if (!isUnicodeWhitespace(cp))
      return {};
    j += *adv;
  }
  if (j >= text.size() || text[j] != '\n')
    return {};
  while (j < text.size() && text[j] == '\n')
    ++j;
  return j;
}

std::vector<std::string> splitParagraphs(const std::string &text) {
  std::vector<std::string> paras;
  size_t start = 0;
  size_t i = 0;
  const size_t n = text.size();
  while (i < n) {
    if (static_cast<unsigned char>(text[i]) != '\n') {
      ++i;
      continue;
    }
    auto end = paragraphBreakEnd(text, i);
    if (!end) {
      ++i;
      continue;
    }
    std::string slice = text.substr(start, i - start);
    trimUtf8(slice);
    if (!slice.empty())
      paras.push_back(std::move(slice));
    start = *end;
    i = *end;
  }
  std::string tail = text.substr(start);
  trimUtf8(tail);
  if (!tail.empty())
    paras.push_back(std::move(tail));
  return paras;
}

static bool matchesAbbrevAtDot(const std::string &s, size_t dotByte) {
  static const std::string_view abbrevs[] = {
      "Mr.",   "Mrs.", "Ms.",  "Dr.", "Prof.", "Sr.",   "Jr.",
      "etc.",  "e.g.", "i.e.", "vs.", "Inc.",  "Ltd.",  "Co.",
      "Corp.", "St.",  "Ave.", "Blvd."};
  if (dotByte >= 4 && s.compare(dotByte - 4, 5, "Ph.D.") == 0)
    return true;
  for (std::string_view ab : abbrevs) {
    if (dotByte + 1 < ab.size())
      continue;
    const size_t st = dotByte + 1 - ab.size();
    if (s.compare(st, ab.size(), ab) != 0)
      continue;
    if (st > 0) {
      const size_t prevStart = utf8CharStartBefore(s, st);
      utf8proc_int32_t prevCp = 0;
      if (!utf8Iterate(s, prevStart, &prevCp))
        continue;
      if (isUnicodeWordChar(prevCp))
        continue;
    }
    return true;
  }
  return false;
}

bool isSentenceSplitBeforeWs(const std::string &para, size_t wsStart) {
  if (wsStart == 0)
    return false;
  const size_t p = utf8CharStartBefore(para, wsStart);
  utf8proc_int32_t punct = 0;
  if (!utf8Iterate(para, p, &punct))
    return false;
  if (punct != '.' && punct != '!' && punct != '?')
    return false;
  if (punct == '.') {
    if (matchesAbbrevAtDot(para, p))
      return false;
    const size_t beforeDot = utf8CharStartBefore(para, p);
    utf8proc_int32_t beforeCp = 0;
    if (!utf8Iterate(para, beforeDot, &beforeCp))
      return true;
    if (beforeCp >= 'A' && beforeCp <= 'Z') {
      if (beforeDot == 0)
        return false;
      const size_t beforeLetter = utf8CharStartBefore(para, beforeDot);
      utf8proc_int32_t bb = 0;
      utf8Iterate(para, beforeLetter, &bb);
      if (!isUnicodeWordChar(bb))
        return false;
    }
  }
  return true;
}

std::vector<std::string> splitSentences(const std::string &para) {
  std::vector<std::string> sents;
  size_t start = 0;
  size_t i = 0;
  const size_t n = para.size();
  while (i < n) {
    utf8proc_int32_t cp = 0;
    auto advOpt = utf8Iterate(para, i, &cp);
    if (!advOpt)
      break;
    if (!isUnicodeWhitespace(cp)) {
      i += *advOpt;
      continue;
    }
    const size_t wsStart = i;
    size_t wsEnd = i;
    while (wsEnd < n) {
      utf8proc_int32_t cp2 = 0;
      auto a2 = utf8Iterate(para, wsEnd, &cp2);
      if (!a2)
        break;
      if (!isUnicodeWhitespace(cp2))
        break;
      wsEnd += *a2;
    }
    if (wsStart > start && isSentenceSplitBeforeWs(para, wsStart)) {
      std::string chunk = para.substr(start, wsStart - start);
      trimUtf8(chunk);
      if (!chunk.empty())
        sents.push_back(std::move(chunk));
      start = wsEnd;
    }
    i = wsEnd;
  }
  std::string tail = para.substr(start);
  trimUtf8(tail);
  if (!tail.empty())
    sents.push_back(std::move(tail));
  return sents;
}

bool isEmojiCodePoint(utf8proc_int32_t c) {
  if (c >= 0x1f600 && c <= 0x1f64f)
    return true;
  if (c >= 0x1f300 && c <= 0x1f5ff)
    return true;
  if (c >= 0x1f680 && c <= 0x1f6ff)
    return true;
  if (c >= 0x1f700 && c <= 0x1f77f)
    return true;
  if (c >= 0x1f780 && c <= 0x1f7ff)
    return true;
  if (c >= 0x1f800 && c <= 0x1f8ff)
    return true;
  if (c >= 0x1f900 && c <= 0x1f9ff)
    return true;
  if (c >= 0x1fa00 && c <= 0x1fa6f)
    return true;
  if (c >= 0x1fa70 && c <= 0x1faff)
    return true;
  if (c >= 0x2600 && c <= 0x26ff)
    return true;
  if (c >= 0x2700 && c <= 0x27bf)
    return true;
  if (c >= 0x1f1e6 && c <= 0x1f1ff)
    return true;
  return false;
}

const std::unordered_set<utf8proc_int32_t> &diacriticsSet() {
  static const std::unordered_set<utf8proc_int32_t> s = {
      0x0302, 0x0303, 0x0304, 0x0305, 0x0306, 0x0307, 0x0308, 0x030a, 0x030b,
      0x030c, 0x0327, 0x0328, 0x0329, 0x032a, 0x032b, 0x032c, 0x032d, 0x032e, 0x032f};
  return s;
}

std::string preprocessForSupertonic(const std::string &rawUtf8,
                                   const std::string *langWrap) {
  utf8proc_uint8_t *nfkdRaw = utf8proc_NFKD(
      reinterpret_cast<const utf8proc_uint8_t *>(rawUtf8.c_str()));
  if (!nfkdRaw)
    throw std::runtime_error("utf8proc_NFKD failed");
  std::string nstr(reinterpret_cast<const char *>(nfkdRaw));
  std::free(nfkdRaw);

  std::string out;
  for (size_t i = 0; i < nstr.size();) {
    utf8proc_int32_t c = 0;
    auto adv = utf8Iterate(nstr, i, &c);
    if (!adv)
      break;
    i += *adv;
    if (isEmojiCodePoint(c))
      continue;
    switch (c) {
    case 0x2013:
    case 0x2011:
    case 0x2014:
      c = '-';
      break;
    case 0x00af:
      c = ' ';
      break;
    case '_':
      c = ' ';
      break;
    case 0x201c:
    case 0x201d:
      c = '"';
      break;
    case 0x2018:
    case 0x2019:
    case 0x00b4:
    case '`':
      c = '\'';
      break;
    case '[':
    case ']':
    case '|':
    case '/':
    case '#':
    case 0x2192:
    case 0x2190:
      c = ' ';
      break;
    default:
      break;
    }
    if (diacriticsSet().count(c) != 0)
      continue;
    if (c == 0x2665 || c == 0x2606 || c == 0x2661 || c == 0x00a9 ||
        c == '\\')
      continue;
    utf8AppendCp(out, c);
  }

  auto replaceAll = [](std::string &s, const std::string &from,
                       const std::string &to) {
    size_t p = 0;
    while ((p = s.find(from, p)) != std::string::npos) {
      s.replace(p, from.size(), to);
      p += to.size();
    }
  };
  replaceAll(out, "@", " at ");
  replaceAll(out, "e.g.,", "for example, ");
  replaceAll(out, "i.e.,", "that is, ");
  replaceAll(out, " ,", ",");
  replaceAll(out, " .", ".");
  replaceAll(out, " !", "!");
  replaceAll(out, " ?", "?");
  replaceAll(out, " ;", ";");
  replaceAll(out, " :", ":");
  replaceAll(out, " '", "'");

  {
    std::string r;
    r.reserve(out.size());
    for (size_t i2 = 0; i2 < out.size();) {
      unsigned char b = static_cast<unsigned char>(out[i2]);
      if ((b == '"' || b == '\'' || b == '`') && i2 + 1 < out.size() &&
          out[i2 + 1] == static_cast<char>(b)) {
        r += static_cast<char>(b);
        while (i2 + 1 < out.size() && out[i2 + 1] == static_cast<char>(b))
          ++i2;
        ++i2;
        continue;
      }
      r += out[i2];
      ++i2;
    }
    out = std::move(r);
  }

  {
    std::string r;
    r.reserve(out.size());
    bool inWs = false;
    for (unsigned char ch : out) {
      if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
        if (!inWs) {
          r += ' ';
          inWs = true;
        }
      } else {
        inWs = false;
        r += static_cast<char>(ch);
      }
    }
    while (!r.empty() && r.front() == ' ')
      r.erase(r.begin());
    while (!r.empty() && r.back() == ' ')
      r.pop_back();
    out = std::move(r);
  }

  if (!out.empty()) {
    const size_t lastStart = utf8CharStartBefore(out, out.size());
    utf8proc_int32_t last = 0;
    utf8Iterate(out, lastStart, &last);
    const bool endsOk =
        utf8proc_category(last) == UTF8PROC_CATEGORY_PO || last == '.' ||
        last == '!' || last == '?' || last == ';' || last == ':' ||
        last == ',' || last == '\'' || last == ')' || last == ']' ||
        last == '}' || last == 0x2019 || last == 0x2026 || last == 0x3002 ||
        last == 0x300d || last == 0x300f || last == 0xff09 ||
        last == 0xff1e || last == 0x300b;
    if (!endsOk)
      out.push_back('.');
  }

  if (langWrap != nullptr && !langWrap->empty()) {
    std::string open = "<" + *langWrap + ">";
    std::string close = "</" + *langWrap + ">";
    out = open + out + close;
  }
  return out;
}

int64_t countUnicodeScalars(const std::string &utf8) {
  int64_t n = 0;
  for (size_t i = 0; i < utf8.size();) {
    utf8proc_int32_t cp = 0;
    auto adv = utf8Iterate(utf8, i, &cp);
    if (!adv)
      break;
    i += *adv;
    (void)cp;
    ++n;
  }
  return n;
}

void flattenStyleDataJson(const nlohmann::json &j, std::vector<float> &out) {
  if (j.is_number()) {
    out.push_back(j.get<float>());
    return;
  }
  if (!j.is_array())
    throw std::runtime_error(
        "voice style data must be a number or nested array of numbers");
  for (const auto &el : j)
    flattenStyleDataJson(el, out);
}

void loadStyleTensor(const nlohmann::json &node, std::vector<int64_t> &shape,
                     std::vector<float> &data) {
  if (!node.contains("dims") || !node.contains("data"))
    throw std::runtime_error("voice style JSON missing dims/data");
  shape.clear();
  for (const auto &d : node["dims"])
    shape.push_back(static_cast<int64_t>(d.get<double>()));
  data.clear();
  flattenStyleDataJson(node["data"], data);
  int64_t prod = 1;
  for (int64_t d : shape) {
    if (d <= 0)
      throw std::runtime_error("invalid style dims");
    prod *= d;
  }
  if (static_cast<int64_t>(data.size()) != prod) {
    throw std::runtime_error("voice style data size does not match dims product");
  }
}

std::vector<float> lengthToMask(int64_t batch, const std::vector<int64_t> &lengths,
                                int64_t maxLen) {
  std::vector<float> mask(static_cast<size_t>(batch * maxLen));
  for (int64_t b = 0; b < batch; ++b) {
    const int64_t L =
        std::clamp(lengths[static_cast<size_t>(b)], INT64_C(0), maxLen);
    for (int64_t k = 0; k < maxLen; ++k) {
      mask[static_cast<size_t>(b * maxLen + k)] =
          (k < L) ? 1.0f : 0.0f;
    }
  }
  return mask;
}

/// Same layout as Python `length_to_mask`: shape (B, 1, max_lat) row-major flat.
std::vector<float> getLatentMask(const std::vector<int64_t> &wavLengthsSamples,
                                 int baseChunk, int compress) {
  const int64_t B = static_cast<int64_t>(wavLengthsSamples.size());
  const int64_t latentSize = static_cast<int64_t>(baseChunk) * compress;
  std::vector<int64_t> latentLens(static_cast<size_t>(B));
  int64_t maxLat = 0;
  for (int64_t b = 0; b < B; ++b) {
    const int64_t wl = wavLengthsSamples[static_cast<size_t>(b)];
    const int64_t ll =
        wl > 0 ? (wl + latentSize - 1) / latentSize : INT64_C(0);
    latentLens[static_cast<size_t>(b)] = ll;
    maxLat = std::max(maxLat, ll);
  }
  return lengthToMask(B, latentLens, maxLat);
}

} // namespace

SupertonicEngine::SupertonicEngine(const SupertonicConfig &cfg) {
  config_ = cfg;
}

SupertonicEngine::~SupertonicEngine() { unload(); }

void SupertonicEngine::unload() {
  loaded_ = false;
  dpSession_.reset();
  textEncSession_.reset();
  vectorEstSession_.reset();
  vocoderSession_.reset();
  unicodeIndexer_.clear();
  styleTtl_.clear();
  styleTtlShape_.clear();
  styleDp_.clear();
  styleDpShape_.clear();
  config_ = {};
}

bool SupertonicEngine::isLoaded() const { return loaded_; }

void SupertonicEngine::load(const SupertonicConfig &cfg) {
  unload();
  config_ = cfg;

  const std::string onnxDir =
      cfg.modelDir.empty() ? "" : resolvePath(cfg.modelDir, "onnx");

  auto pick = [&](const std::string &explicitPath,
                  const std::string &defaultName) {
    return explicitPath.empty()
               ? (onnxDir.empty() ? "" : resolvePath(onnxDir, defaultName))
               : explicitPath;
  };

  std::string dpPath = pick(cfg.durationPredictorPath, "duration_predictor.onnx");
  std::string tePath = pick(cfg.textEncoderPath, "text_encoder.onnx");
  std::string vePath = pick(cfg.vectorEstimatorPath, "vector_estimator.onnx");
  std::string vocPath = pick(cfg.vocoderPath, "vocoder.onnx");
  std::string uniPath =
      cfg.unicodeIndexerPath.empty()
          ? (onnxDir.empty() ? "" : resolvePath(onnxDir, "unicode_indexer.json"))
          : cfg.unicodeIndexerPath;
  std::string ttsPath = cfg.ttsConfigPath.empty()
                            ? (onnxDir.empty() ? "" : resolvePath(onnxDir, "tts.json"))
                            : cfg.ttsConfigPath;

  std::string voiceJson = cfg.voiceStyleJsonPath;
  if (voiceJson.empty() && !cfg.modelDir.empty() && !cfg.voiceName.empty()) {
    voiceJson = resolvePath(resolvePath(cfg.modelDir, "voice_styles"),
                            cfg.voiceName + ".json");
  }

  if (dpPath.empty() || tePath.empty() || vePath.empty() || vocPath.empty() ||
      uniPath.empty() || ttsPath.empty() || voiceJson.empty()) {
    throw std::runtime_error(
        "SupertonicEngine: missing model path(s); set modelDir and "
        "voiceName/voiceStyleJsonPath or explicit ONNX/JSON paths");
  }

  {
    auto j = nlohmann::json::parse(qvac::ttslib::loadFileBytes(ttsPath));
    sampleRate_ =
        static_cast<int>(j["ae"]["sample_rate"].get<double>());
    baseChunkSize_ =
        static_cast<int>(j["ae"]["base_chunk_size"].get<double>());
    chunkCompressFactor_ =
        static_cast<int>(j["ttl"]["chunk_compress_factor"].get<double>());
    latentDim_ =
        static_cast<int>(j["ttl"]["latent_dim"].get<double>());
  }

  {
    auto j = nlohmann::json::parse(qvac::ttslib::loadFileBytes(uniPath));
    if (!j.is_array())
      throw std::runtime_error("unicode_indexer.json must be a JSON array");
    unicodeIndexer_.clear();
    unicodeIndexer_.reserve(j.size());
    for (const auto &el : j)
      unicodeIndexer_.push_back(el.get<int32_t>());
  }

  {
    auto j = nlohmann::json::parse(qvac::ttslib::loadFileBytes(voiceJson));
    if (!j.contains("style_ttl") || !j.contains("style_dp"))
      throw std::runtime_error("voice style JSON must contain style_ttl and style_dp");
    loadStyleTensor(j["style_ttl"], styleTtlShape_, styleTtl_);
    loadStyleTensor(j["style_dp"], styleDpShape_, styleDp_);
  }

  onnx_addon::SessionConfig sessionCfg;
  sessionCfg.provider = cfg.useGPU ? onnx_addon::ExecutionProvider::AUTO_GPU
                                   : onnx_addon::ExecutionProvider::CPU;
  sessionCfg.optimization = onnx_addon::GraphOptimizationLevel::EXTENDED;
  sessionCfg.intraOpThreads = 1;

  Ort::SessionOptions options = onnx_addon::buildSessionOptions(sessionCfg);

  auto createSessions = [&](Ort::SessionOptions &opts) {
    dpSession_ = qvac::ttslib::createOrtSession(dpPath, opts);
    textEncSession_ = qvac::ttslib::createOrtSession(tePath, opts);
    vectorEstSession_ = qvac::ttslib::createOrtSession(vePath, opts);
    vocoderSession_ = qvac::ttslib::createOrtSession(vocPath, opts);
  };

  try {
    createSessions(options);
  } catch (const std::exception &e) {
    if (sessionCfg.provider != onnx_addon::ExecutionProvider::CPU) {
      QLOG(Priority::WARNING,
           std::string("GPU session creation failed, retrying CPU-only: ") +
               e.what());
      onnx_addon::SessionConfig cpuCfg = sessionCfg;
      cpuCfg.provider = onnx_addon::ExecutionProvider::CPU;
      Ort::SessionOptions cpuOptions =
          onnx_addon::buildSessionOptions(cpuCfg);
      createSessions(cpuOptions);
    } else {
      throw;
    }
  }

  static const std::vector<std::string> kLangs = {"en", "ko", "es", "pt", "fr"};
  if (std::find(kLangs.begin(), kLangs.end(), cfg.language) == kLangs.end()) {
    throw std::invalid_argument("Unsupported language: " + cfg.language);
  }

  loaded_ = true;
  QLOG(Priority::INFO,
       "SupertonicEngine loaded (official 4-graph path, sample_rate=" +
           std::to_string(sampleRate_) + ")");
}

std::vector<std::string>
SupertonicEngine::chunkText(const std::string &text, int maxCharLen) const {
  if (maxCharLen < 10)
    throw std::invalid_argument("chunk max length must be >= 10");

  std::string uText = text;
  trimUtf8(uText);
  if (uText.empty())
    return {};

  std::vector<std::string> paragraphs = splitParagraphs(uText);
  if (paragraphs.empty())
    paragraphs = {std::move(uText)};

  std::vector<std::string> chunks;
  for (const auto &para : paragraphs) {
    std::vector<std::string> sentences = splitSentences(para);
    if (sentences.empty())
      sentences = {para};

    std::string current;
    for (const auto &sentRaw : sentences) {
      std::string sent = sentRaw;
      trimUtf8(sent);
      if (sent.empty())
        continue;
      std::string trial = current;
      if (!trial.empty())
        trial.push_back(' ');
      trial += sent;
      if (countUnicodeScalars(trial) <= maxCharLen) {
        current = std::move(trial);
      } else {
        if (!current.empty()) {
          trimUtf8(current);
          if (!current.empty())
            chunks.push_back(std::move(current));
          current.clear();
        }
        current = std::move(sent);
      }
    }
    if (!current.empty()) {
      trimUtf8(current);
      if (!current.empty())
        chunks.push_back(std::move(current));
    }
  }
  return chunks;
}

AudioResult SupertonicEngine::synthesizeChunk(const std::string &text) {
  std::string prep =
      preprocessForSupertonic(text, config_.supertonicMultilingual ? &config_.language
                                                                  : nullptr);
  if (prep.empty())
    throw std::runtime_error("SupertonicEngine: empty text after preprocess");

  const int64_t batch = 1;
  const int64_t textLen =
      countUnicodeScalars(prep); // == Python len(preprocessed)

  std::vector<int64_t> textIds(static_cast<size_t>(textLen));
  {
    int64_t idx = 0;
    for (size_t i = 0; i < prep.size();) {
      utf8proc_int32_t c = 0;
      auto adv = utf8Iterate(prep, i, &c);
      if (!adv)
        break;
      i += *adv;
      const uint32_t cp = static_cast<uint32_t>(c);
      if (cp >= unicodeIndexer_.size())
        throw std::runtime_error("Code point out of unicode indexer range");
      // -1 is valid for multilingual markup (<lang>...</lang>): same as Python
      // UnicodeProcessor + ONNX text_encoder (indexer marks < > / as -1).
      const int32_t id = unicodeIndexer_[cp];
      textIds[static_cast<size_t>(idx++)] = static_cast<int64_t>(id);
    }
    if (idx != textLen)
      throw std::runtime_error("text length mismatch in indexer pipeline");
  }

  const int64_t maxTextLen = textLen;
  std::vector<int64_t> textLenVec = {textLen};
  std::vector<float> textMask = lengthToMask(batch, textLenVec, maxTextLen);

  Ort::MemoryInfo mem = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  std::vector<int64_t> shapeIds = {batch, maxTextLen};
  std::vector<int64_t> shapeMask = {batch, 1, maxTextLen};

  std::vector<Ort::Value> dpInputs;
  dpInputs.push_back(Ort::Value::CreateTensor<int64_t>(
      mem, textIds.data(), textIds.size(), shapeIds.data(), shapeIds.size()));
  dpInputs.push_back(Ort::Value::CreateTensor<float>(
      mem, styleDp_.data(), styleDp_.size(), styleDpShape_.data(),
      styleDpShape_.size()));
  dpInputs.push_back(Ort::Value::CreateTensor<float>(
      mem, textMask.data(), textMask.size(), shapeMask.data(),
      shapeMask.size()));

  const char *dpNames[] = {"text_ids", "style_dp", "text_mask"};
  Ort::AllocatorWithDefaultOptions alloc;
  auto dpOutNm = dpSession_->GetOutputNameAllocated(0, alloc);
  const char *dpOuts[] = {dpOutNm.get()};
  auto dpOutputs = dpSession_->Run(Ort::RunOptions{nullptr}, dpNames,
                                     dpInputs.data(), dpInputs.size(), dpOuts,
                                     1);

  float speed = std::clamp(config_.speed, kMinSpeed, kMaxSpeed);
  const float *durData = dpOutputs[0].GetTensorData<float>();
  const auto durInfo = dpOutputs[0].GetTensorTypeAndShapeInfo();
  const size_t durCount = durInfo.GetElementCount();
  if (durCount < 1)
    throw std::runtime_error("duration predictor returned empty tensor");
  float durSec = durData[0] / speed;
  if (!(durSec > 0.0f) ||
      durSec > static_cast<float>(std::numeric_limits<int>::max()) / sampleRate_)
    throw std::runtime_error("invalid predicted duration");

  std::vector<Ort::Value> teInputs;
  teInputs.push_back(Ort::Value::CreateTensor<int64_t>(
      mem, textIds.data(), textIds.size(), shapeIds.data(), shapeIds.size()));
  teInputs.push_back(Ort::Value::CreateTensor<float>(
      mem, styleTtl_.data(), styleTtl_.size(), styleTtlShape_.data(),
      styleTtlShape_.size()));
  teInputs.push_back(Ort::Value::CreateTensor<float>(
      mem, textMask.data(), textMask.size(), shapeMask.data(),
      shapeMask.size()));
  const char *teNames[] = {"text_ids", "style_ttl", "text_mask"};
  auto teOutNm = textEncSession_->GetOutputNameAllocated(0, alloc);
  const char *teOuts[] = {teOutNm.get()};
  auto teOutputs =
      textEncSession_->Run(Ort::RunOptions{nullptr}, teNames, teInputs.data(),
                           teInputs.size(), teOuts, 1);

  const Ort::Value &textEmb = teOutputs[0];
  const float *textEmbData = textEmb.GetTensorData<float>();
  const auto teShapeInfo = textEmb.GetTensorTypeAndShapeInfo().GetShape();
  const size_t textEmbCount =
      textEmb.GetTensorTypeAndShapeInfo().GetElementCount();
  std::vector<float> textEmbVec(textEmbData, textEmbData + textEmbCount);
  std::vector<int64_t> textEmbShape = teShapeInfo;

  const int latentChannels = latentDim_ * chunkCompressFactor_;
  const int64_t latentSize =
      static_cast<int64_t>(baseChunkSize_) * chunkCompressFactor_;
  // Match Python: (duration * sample_rate).astype(int64) truncates; derive latent_len from that.
  const int64_t wavLen = static_cast<int64_t>(
      static_cast<double>(durSec) * static_cast<double>(sampleRate_));
  const int64_t latentLen =
      wavLen > 0 ? (wavLen + latentSize - 1) / latentSize : INT64_C(0);
  std::vector<int64_t> wavLens = {wavLen};
  std::vector<float> latentMaskRow =
      getLatentMask(wavLens, baseChunkSize_, chunkCompressFactor_);
  const int64_t latentMaskMaxLen =
      static_cast<int64_t>(latentMaskRow.size()) / (batch * 1);

  std::vector<float> noisy(static_cast<size_t>(batch * latentChannels * latentLen));
  {
    std::random_device rd;
    std::mt19937 gen(rd());
    std::normal_distribution<float> dist(0.0f, 1.0f);
    for (float &v : noisy)
      v = dist(gen);
    for (int64_t b = 0; b < batch; ++b) {
      for (int c = 0; c < latentChannels; ++c) {
        for (int64_t k = 0; k < latentLen; ++k) {
          const float m =
              latentMaskRow[static_cast<size_t>(b * latentMaskMaxLen + k)];
          noisy[static_cast<size_t>((b * latentChannels + c) * latentLen + k)] *=
              m;
        }
      }
    }
  }

  std::vector<int64_t> noisyShape = {batch, latentChannels, latentLen};
  std::vector<int64_t> lmShape = {batch, 1, latentMaskMaxLen};

  const int steps = std::clamp(config_.numInferenceSteps, kMinSteps, kMaxSteps);
  std::vector<float> totalStep(batch, static_cast<float>(steps));

  for (int step = 0; step < steps; ++step) {
    std::vector<float> curStep(batch, static_cast<float>(step));
    std::vector<Ort::Value> veInputs;
    veInputs.push_back(Ort::Value::CreateTensor<float>(
        mem, noisy.data(), noisy.size(), noisyShape.data(), noisyShape.size()));
    veInputs.push_back(Ort::Value::CreateTensor<float>(
        mem, textEmbVec.data(), textEmbVec.size(), textEmbShape.data(),
        textEmbShape.size()));
    veInputs.push_back(Ort::Value::CreateTensor<float>(
        mem, styleTtl_.data(), styleTtl_.size(), styleTtlShape_.data(),
        styleTtlShape_.size()));
    veInputs.push_back(Ort::Value::CreateTensor<float>(
        mem, textMask.data(), textMask.size(), shapeMask.data(),
        shapeMask.size()));
    veInputs.push_back(Ort::Value::CreateTensor<float>(
        mem, latentMaskRow.data(), latentMaskRow.size(), lmShape.data(),
        lmShape.size()));
    std::vector<int64_t> bshape = {batch};
    veInputs.push_back(Ort::Value::CreateTensor<float>(
        mem, curStep.data(), curStep.size(), bshape.data(),
        bshape.size()));
    veInputs.push_back(Ort::Value::CreateTensor<float>(
        mem, totalStep.data(), totalStep.size(), bshape.data(),
        bshape.size()));

    const char *veNames[] = {"noisy_latent", "text_emb", "style_ttl",
                             "text_mask",    "latent_mask", "current_step",
                             "total_step"};
    auto veOutNm = vectorEstSession_->GetOutputNameAllocated(0, alloc);
    const char *veOuts[] = {veOutNm.get()};
    auto veOutputs = vectorEstSession_->Run(
        Ort::RunOptions{nullptr}, veNames, veInputs.data(), veInputs.size(),
        veOuts, 1);
    const float *outX = veOutputs[0].GetTensorData<float>();
    const size_t nOut =
        veOutputs[0].GetTensorTypeAndShapeInfo().GetElementCount();
    if (nOut != noisy.size())
      throw std::runtime_error("vector_estimator output size mismatch");
    std::memcpy(noisy.data(), outX, nOut * sizeof(float));
  }

  std::vector<Ort::Value> vocInputs;
  vocInputs.push_back(Ort::Value::CreateTensor<float>(
      mem, noisy.data(), noisy.size(), noisyShape.data(), noisyShape.size()));
  const char *vocNames[] = {"latent"};
  auto vocOutNm = vocoderSession_->GetOutputNameAllocated(0, alloc);
  const char *vocOuts[] = {vocOutNm.get()};
  auto vocOutputs =
      vocoderSession_->Run(Ort::RunOptions{nullptr}, vocNames, vocInputs.data(),
                           vocInputs.size(), vocOuts, 1);
  const float *wavData = vocOutputs[0].GetTensorData<float>();
  const size_t wavCount =
      vocOutputs[0].GetTensorTypeAndShapeInfo().GetElementCount();
  if (wavCount == 0)
    throw std::runtime_error("vocoder returned empty audio");

  AudioResult result;
  result.sampleRate = sampleRate_;
  result.channels = 1;
  result.pcm16.reserve(wavCount);
  result.samples = wavCount;
  result.durationMs = wavCount * 1000.0 / static_cast<double>(sampleRate_);
  for (size_t i = 0; i < wavCount; ++i) {
    const float s = wavData[i];
    const float cl = std::clamp(s, -1.0f, 1.0f);
    result.pcm16.push_back(static_cast<int16_t>(cl * 32767.0f));
  }
  return result;
}

AudioResult SupertonicEngine::synthesize(const std::string &text) {
  if (!loaded_)
    throw std::runtime_error("SupertonicEngine not loaded");

  const int maxChunk =
      (config_.language == "ko") ? 120 : 300;
  std::vector<std::string> chunks = chunkText(text, maxChunk);
  if (chunks.empty()) {
    AudioResult empty;
    empty.sampleRate = sampleRate_;
    empty.channels = 1;
    return empty;
  }

  const int silenceN =
      static_cast<int>(kSilenceBetweenChunksSec * static_cast<double>(sampleRate_));
  std::vector<int16_t> acc;
  for (size_t i = 0; i < chunks.size(); ++i) {
    AudioResult part = synthesizeChunk(chunks[i]);
    if (i > 0)
      acc.insert(acc.end(), static_cast<size_t>(silenceN), 0);
    acc.insert(acc.end(), part.pcm16.begin(), part.pcm16.end());
  }
  AudioResult out;
  out.sampleRate = sampleRate_;
  out.channels = 1;
  out.pcm16 = std::move(acc);
  out.samples = out.pcm16.size();
  out.durationMs =
      out.samples * 1000.0 / static_cast<double>(sampleRate_);
  return out;
}

} // namespace qvac::ttslib::supertonic
