#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <llama.h>

namespace qvac_lib_inference_addon_llama::cache {

// The token array embedded by llama_state_seq_save_file is also our cache
// manifest.  Keep the marker positive: llama_token is signed on some builds.
inline constexpr llama_token LEDGER_MAGIC = 0x514c4447; // "QLDG"
inline constexpr llama_token LEDGER_VERSION = 1;
inline constexpr size_t LEDGER_HEADER_WORDS = 8;
inline constexpr size_t LEDGER_ENTRY_WORDS = 5;
inline constexpr size_t MAX_PROCESS_CHECKPOINTS = 32;

enum class EntryKind : int32_t { Token = 1, Media = 2 };

struct Entry {
  EntryKind kind = EntryKind::Token;
  int64_t identity = 0;
  llama_pos positions = 1;
  llama_pos cacheTokens = 1;

  friend bool operator==(const Entry& a, const Entry& b) {
    return a.kind == b.kind && a.identity == b.identity &&
           a.positions == b.positions && a.cacheTokens == b.cacheTokens;
  }
};

struct Ledger {
  std::vector<Entry> entries;

  [[nodiscard]] llama_pos positions(size_t end) const {
    llama_pos value = 0;
    end = std::min(end, entries.size());
    for (size_t i = 0; i < end; ++i) {
      value += entries[i].positions;
    }
    return value;
  }

  [[nodiscard]] llama_pos cacheTokens(size_t end) const {
    llama_pos value = 0;
    end = std::min(end, entries.size());
    for (size_t i = 0; i < end; ++i) {
      value += entries[i].cacheTokens;
    }
    return value;
  }

  [[nodiscard]] llama_pos positions() const {
    return positions(entries.size());
  }
  [[nodiscard]] llama_pos cacheTokens() const {
    return cacheTokens(entries.size());
  }

  void truncate(size_t count) {
    entries.resize(std::min(count, entries.size()));
  }

  void appendToken(llama_token token) {
    entries.push_back(
        {.kind = EntryKind::Token,
         .identity = static_cast<int64_t>(token),
         .positions = 1,
         .cacheTokens = 1});
  }
};

inline Ledger fromTokens(const std::vector<llama_token>& tokens) {
  Ledger result;
  result.entries.reserve(tokens.size());
  for (llama_token token : tokens) {
    result.appendToken(token);
  }
  return result;
}

inline size_t commonPrefix(const Ledger& a, const Ledger& b) {
  const size_t limit = std::min(a.entries.size(), b.entries.size());
  size_t i = 0;
  while (i < limit && a.entries[i] == b.entries[i]) {
    ++i;
  }
  return i;
}

template <typename T>
void appendProcessCheckpoint(std::deque<T>& checkpoints, T checkpoint) {
  checkpoints.push_back(std::move(checkpoint));
  while (checkpoints.size() > MAX_PROCESS_CHECKPOINTS) {
    checkpoints.pop_front();
  }
}

inline uint64_t hashBytes(const void* data, size_t size) {
  // Stable FNV-1a identity. This is not a security boundary; it prevents a
  // media span from being reused for different content.
  constexpr uint64_t basis = 1469598103934665603ULL;
  constexpr uint64_t prime = 1099511628211ULL;
  uint64_t hash = basis;
  const auto* bytes = static_cast<const uint8_t*>(data);
  for (size_t i = 0; i < size; ++i) {
    hash ^= bytes[i];
    hash *= prime;
  }
  return hash;
}

inline uint64_t checksum(const std::vector<llama_token>& words, size_t begin) {
  return hashBytes(
      words.data() + begin, (words.size() - begin) * sizeof(llama_token));
}

inline std::vector<llama_token>
serialize(const Ledger& ledger, llama_pos nPast, llama_pos cacheTokens) {
  std::vector<llama_token> out(
      LEDGER_HEADER_WORDS + ledger.entries.size() * LEDGER_ENTRY_WORDS);
  out[0] = LEDGER_MAGIC;
  out[1] = LEDGER_VERSION;
  out[2] = static_cast<llama_token>(nPast);
  out[3] = static_cast<llama_token>(cacheTokens);
  out[4] = static_cast<llama_token>(ledger.entries.size());
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  size_t cursor = LEDGER_HEADER_WORDS;
  for (const Entry& entry : ledger.entries) {
    const uint64_t id = static_cast<uint64_t>(entry.identity);
    out[cursor++] = static_cast<llama_token>(entry.kind);
    out[cursor++] = static_cast<llama_token>(id & 0xffffffffULL);
    out[cursor++] = static_cast<llama_token>(id >> 32U);
    out[cursor++] = static_cast<llama_token>(entry.positions);
    out[cursor++] = static_cast<llama_token>(entry.cacheTokens);
  }
  const uint64_t sum = checksum(out, LEDGER_HEADER_WORDS);
  out[5] = static_cast<llama_token>(sum & 0xffffffffULL);
  out[6] = static_cast<llama_token>(sum >> 32U);
  return out;
}

struct DecodedLedger {
  Ledger ledger;
  llama_pos nPast = 0;
  llama_pos cacheTokens = 0;
};

inline bool hasMarker(const llama_token* words, size_t count) {
  return count > 0 && words != nullptr && words[0] == LEDGER_MAGIC;
}

inline DecodedLedger deserialize(const llama_token* words, size_t count) {
  if (!hasMarker(words, count)) {
    throw std::runtime_error("cache ledger marker is missing");
  }
  if (count < LEDGER_HEADER_WORDS) {
    throw std::runtime_error("cache ledger header is truncated");
  }
  if (words[1] != LEDGER_VERSION) {
    throw std::runtime_error("unsupported cache ledger version");
  }
  if (words[2] < 0 || words[3] < 0 || words[4] < 0) {
    throw std::runtime_error("cache ledger contains a negative size");
  }
  const size_t entryCount = static_cast<size_t>(words[4]);
  if (entryCount > (SIZE_MAX - LEDGER_HEADER_WORDS) / LEDGER_ENTRY_WORDS ||
      count != LEDGER_HEADER_WORDS + entryCount * LEDGER_ENTRY_WORDS) {
    throw std::runtime_error("cache ledger length does not match its header");
  }
  std::vector<llama_token> owned(words, words + count);
  const uint64_t expected =
      static_cast<uint32_t>(words[5]) |
      (static_cast<uint64_t>(static_cast<uint32_t>(words[6])) << 32U);
  if (checksum(owned, LEDGER_HEADER_WORDS) != expected) {
    throw std::runtime_error("cache ledger checksum mismatch");
  }

  DecodedLedger result;
  result.nPast = static_cast<llama_pos>(words[2]);
  result.cacheTokens = static_cast<llama_pos>(words[3]);
  result.ledger.entries.reserve(entryCount);
  size_t cursor = LEDGER_HEADER_WORDS;
  for (size_t i = 0; i < entryCount; ++i) {
    const int32_t rawKind = words[cursor++];
    if (rawKind != static_cast<int32_t>(EntryKind::Token) &&
        rawKind != static_cast<int32_t>(EntryKind::Media)) {
      throw std::runtime_error("cache ledger contains an unknown entry kind");
    }
    const uint64_t lo = static_cast<uint32_t>(words[cursor++]);
    const uint64_t hi = static_cast<uint32_t>(words[cursor++]);
    const llama_pos positions = static_cast<llama_pos>(words[cursor++]);
    const llama_pos kv = static_cast<llama_pos>(words[cursor++]);
    if (positions <= 0 || kv <= 0) {
      throw std::runtime_error("cache ledger contains an invalid span");
    }
    result.ledger.entries.push_back(
        {.kind = static_cast<EntryKind>(rawKind),
         .identity = static_cast<int64_t>(lo | (hi << 32U)),
         .positions = positions,
         .cacheTokens = kv});
  }
  if (result.ledger.positions() != result.nPast ||
      result.ledger.cacheTokens() != result.cacheTokens) {
    throw std::runtime_error("cache ledger totals do not match cache state");
  }
  return result;
}

} // namespace qvac_lib_inference_addon_llama::cache
