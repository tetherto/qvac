#pragma once

#include <cctype>
#include <string>
#include <string_view>

namespace qvac_lib_inference_addon_llama {
namespace utils {

/// Longest caller-supplied fragment echoed into an error or log message.
inline constexpr size_t K_MAX_LOG_ECHO = 64;

/// Cap for a diagnostic an operator is meant to act on, rather than a value
/// echoed back at its caller — an upstream chat-template render error, say,
/// whose text quotes the offending template fragment. Bounded all the same,
/// because such a message can embed a whole rendered prompt.
inline constexpr size_t K_MAX_LOG_DIAGNOSTIC = 512;

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
 * truncates to `maxLen`, marking the cut with an ellipsis.
 *
 * `maxLen` defaults to `K_MAX_LOG_ECHO`, the right cap for a value being
 * quoted back at the caller who supplied it. Pass `K_MAX_LOG_DIAGNOSTIC` for
 * an upstream diagnostic that has to stay actionable — the sanitising matters
 * there too, since a model-supplied template controls the text.
 */
inline std::string
forLogMessage(std::string_view value, size_t maxLen = K_MAX_LOG_ECHO) {
  const bool truncated = value.size() > maxLen;
  std::string out;
  const size_t kept = truncated ? maxLen : value.size();
  out.reserve(kept + (truncated ? 3 : 0));
  for (size_t i = 0; i < kept; ++i) {
    const auto c = static_cast<unsigned char>(value[i]);
    // Explicit printable-ASCII range rather than `std::isprint`, for the same
    // reason `toLowerAscii` above avoids `std::tolower`: it is
    // locale-dependent. Under a single-byte LC_CTYPE such as
    // en_US.ISO-8859-1, `isprint(0xE2)` is true, so UTF-8 continuation bytes
    // and the C1 controls 0x80-0x9F would survive the filter this function
    // exists to apply — and the fixed truncation below could then split a
    // multibyte sequence, putting invalid UTF-8 into an error message that
    // crosses the napi boundary. Restricting to 0x20-0x7E makes the
    // truncation split-safe by construction.
    const bool printableAscii = c >= 0x20 && c < 0x7F;
    out += printableAscii ? static_cast<char>(c) : '?';
  }
  if (truncated) {
    out += "...";
  }
  return out;
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
