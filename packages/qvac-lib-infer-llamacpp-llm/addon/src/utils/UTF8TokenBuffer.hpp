#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace qvac_lib_inference_addon_llama {

/**
 * @brief Buffer for accumulating UTF-8 token fragments until complete
 * characters are formed
 *
 * This class solves the emoji display issue by buffering incomplete UTF-8 byte
 * sequences that arrive token-by-token from llama.cpp, and only forwarding
 * complete characters to the JavaScript layer.
 */
class UTF8TokenBuffer {
private:
  std::vector<uint8_t> buffer_;

public:
  /**
   * @brief Add a token string to the buffer
   * @param token The token string from llama.cpp (may contain incomplete UTF-8
   * sequences)
   * @return String containing any complete UTF-8 characters that can be
   * extracted
   */
  std::string addToken(const std::string& token) {
    // Add token bytes to buffer
    for (char c : token) {
      buffer_.push_back(static_cast<uint8_t>(c));
    }

    return extractCompleteChars();
  }

  /**
   * @brief Extract complete UTF-8 characters from buffer
   * @return String with complete UTF-8 characters, leaving incomplete ones in
   * buffer
   */
  std::string extractCompleteChars() {
    std::string result;
    size_t consumed = 0;

    for (size_t i = 0; i < buffer_.size();) {
      uint8_t byte = buffer_[i];
      int seqLen = getUTF8SequenceLength(byte);

      if (seqLen == 0) {
        // Invalid start byte, skip it
        consumed = i + 1;
        i++;
        continue;
      }

      // Check if we have complete sequence
      if (i + seqLen <= buffer_.size()) {
        // Validate continuation bytes for multi-byte sequences
        bool valid = true;
        for (int j = 1; j < seqLen; j++) {
          if ((buffer_[i + j] & 0xC0) != 0x80) {
            valid = false;
            break;
          }
        }

        if (valid) {
          // Complete valid sequence - add to result
          for (int j = 0; j < seqLen; j++) {
            result.push_back(static_cast<char>(buffer_[i + j]));
          }
          consumed = i + seqLen;
          i = consumed;
        } else {
          // Invalid sequence, skip start byte
          consumed = i + 1;
          i++;
        }
      } else {
        // Incomplete sequence - stop processing
        break;
      }
    }

    // Remove processed bytes from buffer
    buffer_.erase(buffer_.begin(), buffer_.begin() + consumed);
    return result;
  }

  /**
   * @brief Force flush remaining bytes (for end of generation)
   * @return Any remaining bytes as a string (may be incomplete)
   */
  std::string flush() {
    if (buffer_.empty()) {
      return "";
    }

    std::string remaining;
    for (uint8_t byte : buffer_) {
      remaining.push_back(static_cast<char>(byte));
    }
    buffer_.clear();
    return remaining;
  }

  /**
   * @brief Check if buffer has pending bytes
   */
  bool hasPendingBytes() const { return !buffer_.empty(); }

  /**
   * @brief Clear the buffer
   */
  void clear() { buffer_.clear(); }

private:
  /**
   * @brief Determine UTF-8 sequence length from first byte
   * @param first_byte The first byte of a potential UTF-8 sequence
   * @return Length of the sequence (1-4), or 0 if invalid start byte
   */
  int getUTF8SequenceLength(uint8_t firstByte) const {
    if ((firstByte & 0x80) == 0) {
      return 1; // 0xxxxxxx - ASCII
    } else if ((firstByte & 0xE0) == 0xC0) {
      return 2; // 110xxxxx - 2 bytes
    } else if ((firstByte & 0xF0) == 0xE0) {
      return 3; // 1110xxxx - 3 bytes
    } else if ((firstByte & 0xF8) == 0xF0) {
      return 4; // 11110xxx - 4 bytes (emojis!)
    } else {
      return 0; // Invalid start byte
    }
  }
};

} // namespace qvac_lib_inference_addon_llama
