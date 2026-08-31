#pragma once

#include <cctype>
#include <string>
#include <string_view>

namespace qvac_lib_inference_addon_llama {
namespace utils {

/// Longest caller-supplied fragment echoed into an error or log message.
inline constexpr size_t K_MAX_LOG_ECHO = 64;

/// Lowercases in place, for case-insensitive stop-string matching. Kept here
/// so the two LLM contexts share one definition.
inline std::string toLowerAscii(std::string_view value) {
  std::string out;
  out.reserve(value.size());
  for (const char c : value) {
    // Explicit 'A'-'Z' rather than `std::tolower`, which is locale-dependent:
    // under a non-"C" LC_CTYPE it can fold bytes >= 0x80 and corrupt the UTF-8
    // in a stop string. Stop-string matching is byte-wise, so leaving
    // multibyte sequences untouched is what makes it correct.
    out += (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c;
  }
  return out;
}

/**
 * @brief Makes a caller-supplied string safe to embed in an error message.
 *
 * Error messages reach JS and every log sink that records them, and on the
 * async job path the error *code* is dropped, so the message text is the whole
 * signal. An unbounded value would bloat it, and control characters would let
 * a caller forge log lines. Replaces non-printable bytes with '?' and
 * truncates to `K_MAX_LOG_ECHO`, marking the cut with an ellipsis.
 */
inline std::string forLogMessage(std::string_view value) {
  const bool truncated = value.size() > K_MAX_LOG_ECHO;
  std::string out;
  const size_t kept = truncated ? K_MAX_LOG_ECHO : value.size();
  out.reserve(kept + (truncated ? 3 : 0));
  for (size_t i = 0; i < kept; ++i) {
    const auto c = static_cast<unsigned char>(value[i]);
    out += (std::isprint(c) != 0) ? static_cast<char>(c) : '?';
  }
  if (truncated) {
    out += "...";
  }
  return out;
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
