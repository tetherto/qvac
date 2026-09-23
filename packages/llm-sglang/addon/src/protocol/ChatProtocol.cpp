#include "protocol/ChatProtocol.hpp"

#include <cctype>
#include <cstdio>
#include <stdexcept>
#include <utility>

namespace qvac_llm_sglang {
namespace {

std::string jsonEscape(std::string_view text) {
  std::string out;
  out.reserve(text.size());
  for (unsigned char c : text) {
    switch (c) {
    case '"':
      out += "\\\"";
      break;
    case '\\':
      out += "\\\\";
      break;
    case '\b':
      out += "\\b";
      break;
    case '\f':
      out += "\\f";
      break;
    case '\n':
      out += "\\n";
      break;
    case '\r':
      out += "\\r";
      break;
    case '\t':
      out += "\\t";
      break;
    default:
      if (c < 0x20) {
        char buf[8];
        std::snprintf(buf, sizeof(buf), "\\u%04x", c);
        out += buf;
      } else {
        out.push_back(static_cast<char>(c));
      }
    }
  }
  return out;
}

std::string base64(const std::vector<std::uint8_t>& bytes) {
  static constexpr char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((bytes.size() + 2) / 3) * 4);
  std::size_t i = 0;
  while (i + 3 <= bytes.size()) {
    const unsigned n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push_back(kAlphabet[(n >> 18) & 63]);
    out.push_back(kAlphabet[(n >> 12) & 63]);
    out.push_back(kAlphabet[(n >> 6) & 63]);
    out.push_back(kAlphabet[n & 63]);
    i += 3;
  }
  if (i < bytes.size()) {
    unsigned n = bytes[i] << 16;
    out.push_back(kAlphabet[(n >> 18) & 63]);
    if (i + 1 < bytes.size()) {
      n |= bytes[i + 1] << 8;
      out.push_back(kAlphabet[(n >> 12) & 63]);
      out.push_back(kAlphabet[(n >> 6) & 63]);
      out.push_back('=');
    } else {
      out.push_back(kAlphabet[(n >> 12) & 63]);
      out += "==";
    }
  }
  return out;
}

std::string imageMime(const std::vector<std::uint8_t>& bytes) {
  if (bytes.size() >= 8 && bytes[0] == 0x89 && bytes[1] == 'P' &&
      bytes[2] == 'N' && bytes[3] == 'G') {
    return "image/png";
  }
  if (bytes.size() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 &&
      bytes[2] == 0xff) {
    return "image/jpeg";
  }
  if (bytes.size() >= 6 && bytes[0] == 'G' && bytes[1] == 'I' &&
      bytes[2] == 'F') {
    return "image/gif";
  }
  if (bytes.size() >= 12 && bytes[0] == 'R' && bytes[1] == 'I' &&
      bytes[2] == 'F' && bytes[3] == 'F' && bytes[8] == 'W' &&
      bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P') {
    return "image/webp";
  }
  return "application/octet-stream";
}

std::string percentEncode(unsigned char c) {
  char buf[4];
  std::snprintf(buf, sizeof(buf), "%%%02X", c);
  return buf;
}

std::string fileUrl(const std::string& path) {
  std::string url = "file://";
  for (unsigned char c : path) {
    if (std::isalnum(c) || c == '/' || c == '-' || c == '_' || c == '.' ||
        c == '~') {
      url.push_back(static_cast<char>(c));
    } else {
      url += percentEncode(c);
    }
  }
  return url;
}

std::string imageUrl(const ContentPart& part) {
  if (!part.bytes.empty()) {
    return "data:" + imageMime(part.bytes) + ";base64," + base64(part.bytes);
  }
  if (!part.path.empty()) {
    return fileUrl(part.path);
  }
  throw std::invalid_argument("image message requires bytes or a file path");
}

void appendNumber(std::string& body, std::string_view key, double value) {
  body.push_back(',');
  body.push_back('"');
  body.append(key);
  body += "\":";
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.17g", value);
  body += buf;
}

void appendInt(std::string& body, std::string_view key, int value) {
  body.push_back(',');
  body.push_back('"');
  body.append(key);
  body += "\":";
  body += std::to_string(value);
}

void appendStringField(
    std::string& body, std::string_view key, const std::string& value) {
  body.push_back(',');
  body.push_back('"');
  body.append(key);
  body += "\":\"";
  body += jsonEscape(value);
  body.push_back('"');
}

std::string contentJson(const ContentPart& part) {
  if (part.media == MediaKind::Audio) {
    throw std::invalid_argument("audio inputs are not supported");
  }
  if (part.media == MediaKind::Video) {
    throw std::invalid_argument("video inputs are not supported");
  }
  if (part.media == MediaKind::Image) {
    return "{\"type\":\"image_url\",\"image_url\":{\"url\":\"" +
           jsonEscape(imageUrl(part)) + "\"}}";
  }
  return "{\"type\":\"text\",\"text\":\"" + jsonEscape(part.text) + "\"}";
}

bool textOnly(const ChatTurn& turn) {
  return turn.parts.size() == 1 && turn.parts[0].media == MediaKind::None;
}

std::optional<std::string> jsonStringField(
    std::string_view json, std::string_view key) {
  const std::string pattern = "\"" + std::string(key) + "\":";
  const auto pos = json.find(pattern);
  if (pos == std::string_view::npos) {
    return std::nullopt;
  }
  std::size_t i = pos + pattern.size();
  while (i < json.size() &&
         std::isspace(static_cast<unsigned char>(json[i]))) {
    ++i;
  }
  if (i + 4 <= json.size() && json.substr(i, 4) == "null") {
    return std::nullopt;
  }
  if (i >= json.size() || json[i] != '"') {
    return std::nullopt;
  }
  return decodeJsonString(json, i);
}

void appendUtf8(std::string& out, unsigned code) {
  if (code <= 0x7f) {
    out.push_back(static_cast<char>(code));
  } else if (code <= 0x7ff) {
    out.push_back(static_cast<char>(0xc0 | (code >> 6)));
    out.push_back(static_cast<char>(0x80 | (code & 0x3f)));
  } else if (code <= 0xffff) {
    out.push_back(static_cast<char>(0xe0 | (code >> 12)));
    out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3f)));
    out.push_back(static_cast<char>(0x80 | (code & 0x3f)));
  } else {
    out.push_back(static_cast<char>(0xf0 | (code >> 18)));
    out.push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3f)));
    out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3f)));
    out.push_back(static_cast<char>(0x80 | (code & 0x3f)));
  }
}

} // namespace

std::string decodeJsonString(std::string_view json, std::size_t cursor) {
  if (cursor >= json.size() || json[cursor] != '"') {
    throw std::runtime_error("expected a JSON string");
  }
  std::string out;
  for (std::size_t i = cursor + 1; i < json.size(); ++i) {
    const char c = json[i];
    if (c == '"') {
      return out;
    }
    if (c != '\\') {
      out.push_back(c);
      continue;
    }
    if (++i >= json.size()) {
      throw std::runtime_error("truncated JSON string");
    }
    switch (json[i]) {
    case '"':
    case '\\':
    case '/':
      out.push_back(json[i]);
      break;
    case 'b':
      out.push_back('\b');
      break;
    case 'f':
      out.push_back('\f');
      break;
    case 'n':
      out.push_back('\n');
      break;
    case 'r':
      out.push_back('\r');
      break;
    case 't':
      out.push_back('\t');
      break;
    case 'u': {
      if (i + 4 >= json.size()) {
        throw std::runtime_error("truncated JSON unicode escape");
      }
      unsigned code = 0;
      for (int n = 0; n < 4; ++n) {
        const char hex = json[++i];
        code <<= 4;
        if (hex >= '0' && hex <= '9') {
          code |= static_cast<unsigned>(hex - '0');
        } else if (hex >= 'a' && hex <= 'f') {
          code |= static_cast<unsigned>(hex - 'a' + 10);
        } else if (hex >= 'A' && hex <= 'F') {
          code |= static_cast<unsigned>(hex - 'A' + 10);
        } else {
          throw std::runtime_error("invalid JSON unicode escape");
        }
      }
      appendUtf8(out, code);
      break;
    }
    default:
      throw std::runtime_error("invalid JSON string escape");
    }
  }
  throw std::runtime_error("truncated JSON string");
}

std::string buildChatBody(
    const std::vector<ChatTurn>& messages, const SamplingParams& sampling) {
  if (messages.empty()) {
    throw std::invalid_argument("messages must not be empty");
  }
  std::string body = "{\"messages\":[";
  for (std::size_t i = 0; i < messages.size(); ++i) {
    const ChatTurn& turn = messages[i];
    if (turn.role.empty()) {
      throw std::invalid_argument("chat message role is required");
    }
    if (turn.parts.empty()) {
      throw std::invalid_argument("chat message content is required");
    }
    if (i > 0) {
      body.push_back(',');
    }
    body += "{\"role\":\"";
    body += jsonEscape(turn.role);
    body += "\",\"content\":";
    if (textOnly(turn)) {
      body.push_back('"');
      body += jsonEscape(turn.parts[0].text);
      body.push_back('"');
    } else {
      body.push_back('[');
      for (std::size_t p = 0; p < turn.parts.size(); ++p) {
        if (p > 0) {
          body.push_back(',');
        }
        body += contentJson(turn.parts[p]);
      }
      body.push_back(']');
    }
    body.push_back('}');
  }
  body += "],\"stream\":true";
  if (sampling.temperature) {
    appendNumber(body, "temperature", *sampling.temperature);
  }
  if (sampling.topP) {
    appendNumber(body, "top_p", *sampling.topP);
  }
  if (sampling.topK) {
    appendInt(body, "top_k", *sampling.topK);
  }
  if (sampling.maxTokens) {
    appendInt(body, "max_tokens", *sampling.maxTokens);
  }
  if (sampling.seed) {
    appendInt(body, "seed", *sampling.seed);
  }
  if (sampling.frequencyPenalty) {
    appendNumber(body, "frequency_penalty", *sampling.frequencyPenalty);
  }
  if (sampling.presencePenalty) {
    appendNumber(body, "presence_penalty", *sampling.presencePenalty);
  }
  if (sampling.repetitionPenalty) {
    appendNumber(body, "repetition_penalty", *sampling.repetitionPenalty);
  }
  if (sampling.jsonSchema) {
    appendStringField(body, "json_schema", *sampling.jsonSchema);
  }
  if (sampling.grammar) {
    appendStringField(body, "grammar", *sampling.grammar);
  }
  body.push_back('}');
  return body;
}

std::vector<std::string> SseParser::consumeLine(std::string_view line) {
  if (!line.empty() && line.back() == '\r') {
    line.remove_suffix(1);
  }
  constexpr std::string_view kData = "data:";
  if (line.size() < kData.size() || line.substr(0, kData.size()) != kData) {
    return {};
  }
  std::string_view payload = line.substr(kData.size());
  if (!payload.empty() && payload.front() == ' ') {
    payload.remove_prefix(1);
  }
  if (payload == "[DONE]") {
    done_ = true;
    return {};
  }
  if (payload.find("\"error\"") != std::string_view::npos &&
      payload.find("\"delta\"") == std::string_view::npos) {
    const auto message = jsonStringField(payload, "message");
    throw std::runtime_error(message.value_or(std::string(payload)));
  }
  const auto content = jsonStringField(payload, "content");
  if (!content.has_value() || content->empty()) {
    return {};
  }
  // `"reasoning_content"` does not contain the key `"content"`. A content
  // field that is only the reasoning channel stays out of the token stream.
  if (payload.find("\"content\":") == std::string_view::npos) {
    return {};
  }
  return {*content};
}

std::vector<std::string> SseParser::feed(std::string_view chunk) {
  buffer_.append(chunk);
  std::vector<std::string> deltas;
  for (;;) {
    const auto nl = buffer_.find('\n');
    if (nl == std::string::npos) {
      break;
    }
    const std::string line = buffer_.substr(0, nl);
    buffer_.erase(0, nl + 1);
    auto parsed = consumeLine(line);
    deltas.insert(deltas.end(), parsed.begin(), parsed.end());
  }
  return deltas;
}

} // namespace qvac_llm_sglang
