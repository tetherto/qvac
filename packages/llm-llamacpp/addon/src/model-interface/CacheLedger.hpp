#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <llama.h>

#include "utils/ParseUnsigned.hpp"
#include "utils/SequenceStateSnapshot.hpp"

namespace qvac_lib_inference_addon_llama::cache {

// The token array embedded by llama_state_seq_save_file is also our cache
// manifest.  Keep the marker positive: llama_token is signed on some builds.
inline constexpr llama_token LEDGER_MAGIC = 0x514c4447; // "QLDG"
inline constexpr llama_token LEDGER_VERSION = 1;
inline constexpr size_t LEDGER_HEADER_WORDS = 8;
inline constexpr size_t LEDGER_ENTRY_WORDS = 5;
// Process-local full-state checkpoints kept per sequence on models that
// cannot trim a KV tail. One is added per committed cached request, and each
// is a full copy of the sequence state (on disk or in memory, see
// `SnapshotStorage`), so the policy below bounds that footprint.
//   * `cache_checkpoints`: how many to keep; 0 keeps none, which turns every
//     divergent turn into a cold prefill.
//   * `cache_checkpoints_max_bytes`: total payload budget per sequence; 0 is
//     unlimited. It is enforced before the count, and the model load fails
//     early when it cannot hold `cache_checkpoints` checkpoints of the
//     largest size the context allows.
//   * `cache_checkpoint_storage`: `disk` (temp files, default) or `memory`.
inline constexpr size_t DEFAULT_PROCESS_CHECKPOINTS = 32;
inline constexpr size_t MAX_CONFIGURABLE_PROCESS_CHECKPOINTS = 1024;
inline constexpr const char* CACHE_CHECKPOINTS_KEY = "cache_checkpoints";
inline constexpr const char* CACHE_CHECKPOINTS_KEY_DASHED = "cache-checkpoints";
inline constexpr const char* CACHE_CHECKPOINTS_MAX_BYTES_KEY =
    "cache_checkpoints_max_bytes";
inline constexpr const char* CACHE_CHECKPOINTS_MAX_BYTES_KEY_DASHED =
    "cache-checkpoints-max-bytes";
inline constexpr const char* CACHE_CHECKPOINT_STORAGE_KEY =
    "cache_checkpoint_storage";
inline constexpr const char* CACHE_CHECKPOINT_STORAGE_KEY_DASHED =
    "cache-checkpoint-storage";

struct CheckpointPolicy {
  size_t maxCount = DEFAULT_PROCESS_CHECKPOINTS;
  uint64_t maxBytes = 0; // 0 = unlimited
  qvac_lib_inference_addon_llama::utils::SnapshotStorage storage =
      qvac_lib_inference_addon_llama::utils::SnapshotStorage::Disk;
};

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

// A process-local checkpoint of a sequence whose memory cannot be trimmed:
// the saved state and the ledger it describes. `cacheTokens` is the KV cells
// that memory occupies, which exceeds `ledger.positions()` after M-RoPE
// media. Checkpoints only ever describe a prefix of some prompt, so they stay
// valid for any resident memory whose ledger shares that prefix.
struct Checkpoint {
  qvac_lib_inference_addon_llama::utils::SequenceStateSnapshot state;
  Ledger ledger;
  llama_pos cacheTokens = 0;
};
using Checkpoints = std::deque<Checkpoint>;

// Appends `checkpoint` and evicts from the oldest end until both limits of
// `policy` hold: total payload bytes (measured by `bytesOf`) within
// `maxBytes` when set, then count within `maxCount`. A single checkpoint
// larger than the whole budget is evicted immediately.
template <typename T, typename BytesOf>
void appendProcessCheckpoint(
    std::deque<T>& checkpoints, T checkpoint, const CheckpointPolicy& policy,
    BytesOf bytesOf) {
  checkpoints.push_back(std::move(checkpoint));
  const auto totalBytes = [&]() {
    uint64_t sum = 0;
    for (const T& entry : checkpoints) {
      sum += bytesOf(entry);
    }
    return sum;
  };
  while (!checkpoints.empty() &&
         (checkpoints.size() > policy.maxCount ||
          (policy.maxBytes > 0 && totalBytes() > policy.maxBytes))) {
    checkpoints.pop_front();
  }
}

// Checkpoints whose ledger is a prefix of `prompt` spanning at most
// `maxEntries` entries, longest first. `T` needs a `ledger` member.
template <typename T>
std::vector<T*> usableCheckpointsLongestFirst(
    std::deque<T>& checkpoints, const Ledger& prompt, size_t maxEntries) {
  std::vector<T*> usable;
  for (T& checkpoint : checkpoints) {
    const size_t size = checkpoint.ledger.entries.size();
    if (size <= maxEntries && commonPrefix(checkpoint.ledger, prompt) == size) {
      usable.push_back(&checkpoint);
    }
  }
  std::stable_sort(usable.begin(), usable.end(), [](const T* a, const T* b) {
    return a->ledger.entries.size() > b->ledger.entries.size();
  });
  return usable;
}

// Consumes one addon-only key that may be spelled with underscores or dashes.
// Returns the value, or nothing when neither spelling is present. Throws
// std::invalid_argument when both are given.
inline std::optional<std::pair<std::string, std::string>> takeConfigKey(
    std::unordered_map<std::string, std::string>& config,
    const char* underscoreKey, const char* dashedKey) {
  const auto underscore = config.find(underscoreKey);
  const auto dashed = config.find(dashedKey);
  if (underscore != config.end() && dashed != config.end()) {
    throw std::invalid_argument(
        std::string(underscoreKey) + " and " + dashedKey +
        " must not both be set");
  }
  const auto it = underscore != config.end() ? underscore : dashed;
  if (it == config.end()) {
    return std::nullopt;
  }
  std::pair<std::string, std::string> taken{it->first, it->second};
  config.erase(it);
  return taken;
}

// Consumes the checkpoint keys from the load config and returns the policy.
// Absent keys keep their defaults. Throws std::invalid_argument for a
// malformed or out-of-range value, an unknown storage name, or both spellings
// of one key; callers translate it into their error type.
inline CheckpointPolicy
parseCheckpointPolicy(std::unordered_map<std::string, std::string>& config) {
  using qvac_lib_inference_addon_llama::utils::SnapshotStorage;
  CheckpointPolicy policy;
  if (const auto count = takeConfigKey(
          config, CACHE_CHECKPOINTS_KEY, CACHE_CHECKPOINTS_KEY_DASHED)) {
    policy.maxCount = parseUnsignedInRange(
        count->second, 0, MAX_CONFIGURABLE_PROCESS_CHECKPOINTS, count->first);
  }
  if (const auto bytes = takeConfigKey(
          config,
          CACHE_CHECKPOINTS_MAX_BYTES_KEY,
          CACHE_CHECKPOINTS_MAX_BYTES_KEY_DASHED)) {
    policy.maxBytes = parseUnsigned64InRange(
        bytes->second, 0, std::numeric_limits<uint64_t>::max(), bytes->first);
  }
  if (const auto storage = takeConfigKey(
          config,
          CACHE_CHECKPOINT_STORAGE_KEY,
          CACHE_CHECKPOINT_STORAGE_KEY_DASHED)) {
    if (storage->second == "disk") {
      policy.storage = SnapshotStorage::Disk;
    } else if (storage->second == "memory") {
      policy.storage = SnapshotStorage::Memory;
    } else {
      throw std::invalid_argument(
          storage->first + " must be \"disk\" or \"memory\", got: \"" +
          storage->second + "\"");
    }
  }
  return policy;
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
