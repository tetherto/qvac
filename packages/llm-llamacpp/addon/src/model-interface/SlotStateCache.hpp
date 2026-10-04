#pragma once

#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <list>
#include <mutex>
#include <optional>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

#include <llama.h>

#include <inference-addon-cpp/Errors.hpp>

#include "CacheLedger.hpp"
#include "CacheManager.hpp"
#include "addon/LlmErrors.hpp"

namespace qvac_lib_inference_addon_llama::batching {

/// A conversation state moved out of the sequence it ran on: the full
/// sequence state and the ledger that describes it, plus the checkpoints that
/// go with it.
struct SlotStateCacheEntry {
  /// `llama_state_seq_get_data_ext(ctx, seq, 0)`: exactly the payload a
  /// `llama_state_seq_save_file` writes after its header.
  std::vector<uint8_t> state;
  std::vector<llama_token> ledgerWords;
  cache::Checkpoints checkpoints;
  /// Has turns its `cacheKey` file does not hold yet.
  bool dirty = false;
  /// The state was loaded from, or last written to, its `cacheKey` file.
  bool activeCacheSavedToDisk = false;
  /// Its last request set `ephemeral`: never written automatically, dropped
  /// when the tier lets it go.
  bool ephemeral = false;

  [[nodiscard]] uint64_t bytes() const noexcept {
    uint64_t total = state.size() + ledgerWords.size() * sizeof(llama_token);
    for (const cache::Checkpoint& checkpoint : checkpoints) {
      // Disk-stored checkpoints hold a temp-file path, not RAM.
      if (checkpoint.state.hasBuffer()) {
        total += checkpoint.state.bytes();
      }
    }
    return total;
  }
};

/// Host-RAM tier for conversation states (`cache_ram_mib`), keyed by
/// `cacheKey`, oldest first, shared by the single-prompt path (a key switch
/// moves the outgoing conversation here) and the batch scheduler (a slot
/// eviction does). It is a write-back cache: a conversation with unsaved turns
/// stays in RAM, and reaches its `cacheKey` file only when the budget forces
/// it out or on `flushDirty()`, which the model runs when it is unloaded.
/// Ephemeral entries are never written automatically: the budget or an unload
/// drops them. Insert and eviction follow llama-server's `server_prompt_cache::alloc`: an
/// entry larger than the whole budget is not kept, a newer entry for the same
/// key replaces the older one, and the oldest entries are evicted until a new
/// one fits. Thread-safe.
class SlotStateCache {
public:
  explicit SlotStateCache(uint64_t budgetBytes = 0) : budget_(budgetBytes) {}

  [[nodiscard]] uint64_t budget() const noexcept { return budget_; }
  [[nodiscard]] bool enabled() const noexcept { return budget_ > 0; }

  /// Keeps `entry` under `key` and returns true. When it does not fit the
  /// budget even alone, `entry` is left untouched and false is returned: the
  /// caller saves it the way it would without the tier.
  bool insert(const std::string& key, SlotStateCacheEntry&& entry) {
    std::scoped_lock lock(mutex_);
    const uint64_t size = entry.bytes();
    if (!enabled() || size > budget_) {
      return false;
    }
    eraseLocked(key);
    while (!entries_.empty() && totalBytesLocked() + size > budget_) {
      dropOldestLocked();
    }
    entries_.emplace_back(key, std::move(entry));
    return true;
  }

  /// Removes and returns the entry for `key`, if any.
  [[nodiscard]] std::optional<SlotStateCacheEntry>
  take(const std::string& key) {
    std::scoped_lock lock(mutex_);
    for (auto it = entries_.begin(); it != entries_.end(); ++it) {
      if (it->first == key) {
        SlotStateCacheEntry entry = std::move(it->second);
        entries_.erase(it);
        return entry;
      }
    }
    return std::nullopt;
  }

  /// Writes every dirty, non-ephemeral entry to its `cacheKey` file and marks
  /// it clean. Entries stay in RAM. Returns how many were written.
  size_t flushDirty() {
    std::scoped_lock lock(mutex_);
    size_t written = 0;
    for (auto& [key, entry] : entries_) {
      if (entry.dirty && !entry.ephemeral && writeBack(key, entry)) {
        entry.dirty = false;
        entry.activeCacheSavedToDisk = true;
        ++written;
      }
    }
    return written;
  }

  enum class SaveOutcome { NotHere, Written, Current };

  /// The caller's explicit save (`saveCache`): writes the entry for `key` to
  /// its file unless the file already holds it. Ephemeral entries and entries
  /// whose file was deleted are written too: the caller asked. Throws
  /// `UnableToSaveSessionFile` when the write fails; the entry stays, dirty.
  SaveOutcome save(const std::string& key) {
    std::scoped_lock lock(mutex_);
    for (auto& [entryKey, entry] : entries_) {
      if (entryKey != key) {
        continue;
      }
      if (!entry.dirty && entry.activeCacheSavedToDisk &&
          !CacheManager::persistedBackingStoreMissing(key)) {
        return SaveOutcome::Current;
      }
      if (!writeStateFile(key, entry)) {
        throw qvac_errors::StatusError(
            errors::ADDON_ID,
            errors::toString(errors::UnableToSaveSessionFile),
            "failed to save the cache state kept in RAM to '" + key + "'");
      }
      entry.dirty = false;
      entry.activeCacheSavedToDisk = true;
      return SaveOutcome::Written;
    }
    return SaveOutcome::NotHere;
  }

  /// Drops everything without writing it (a reset).
  void clear() noexcept {
    std::scoped_lock lock(mutex_);
    entries_.clear();
  }

  [[nodiscard]] size_t size() const {
    std::scoped_lock lock(mutex_);
    return entries_.size();
  }

  [[nodiscard]] uint64_t totalBytes() const {
    std::scoped_lock lock(mutex_);
    return totalBytesLocked();
  }

  /// Writes `entry` to `path` in the format `llama_state_seq_save_file`
  /// produces and every cache load reads: magic, version, ledger token
  /// count, ledger tokens, then the sequence state. Through a temp file, like
  /// every other cache write. Returns false (and leaves `path` untouched) on
  /// failure.
  static bool writeStateFile(
      const std::string& path, const SlotStateCacheEntry& entry) noexcept {
    const std::string tmp = path + ".tmp";
    try {
      {
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        const uint32_t header[] = {
            LLAMA_STATE_SEQ_MAGIC,
            LLAMA_STATE_SEQ_VERSION,
            static_cast<uint32_t>(entry.ledgerWords.size())};
        out.write(reinterpret_cast<const char*>(header), sizeof(header));
        out.write(
            reinterpret_cast<const char*>(entry.ledgerWords.data()),
            static_cast<std::streamsize>(
                entry.ledgerWords.size() * sizeof(llama_token)));
        // `llama_state_seq_get_data` prefixes the sequence state with an
        // in-memory marker and the source seq id, which the file format does
        // not carry (`state_seq_save_file` writes the state right after the
        // tokens). Drop that prefix when present.
        size_t offset = 0;
        uint32_t marker = 0;
        if (entry.state.size() >= kGetDataPrefixBytes) {
          std::memcpy(&marker, entry.state.data(), sizeof(marker));
          if (marker == kGetDataMarker) {
            offset = kGetDataPrefixBytes;
          }
        }
        out.write(
            reinterpret_cast<const char*>(entry.state.data() + offset),
            static_cast<std::streamsize>(entry.state.size() - offset));
        if (!out) {
          throw std::runtime_error("short write");
        }
      }
      CacheManager::atomicPromoteFile(tmp, path);
      return true;
    } catch (...) {
      std::error_code ec;
      std::filesystem::remove(tmp, ec);
      return false;
    }
  }

private:
  /// Marker `llama_state_seq_get_data` writes first (llama-context.cpp
  /// `io_magic`), followed by the source `llama_seq_id`.
  static constexpr uint32_t kGetDataMarker = 0xaf143cd8;
  static constexpr size_t kGetDataPrefixBytes =
      sizeof(uint32_t) + sizeof(llama_seq_id);

  /// A caller that deleted the file this state came from dropped the
  /// conversation; do not bring it back.
  static bool
  writeBack(const std::string& key, const SlotStateCacheEntry& entry) {
    if (entry.activeCacheSavedToDisk &&
        CacheManager::persistedBackingStoreMissing(key)) {
      return false;
    }
    return writeStateFile(key, entry);
  }

  void dropOldestLocked() {
    auto& [key, entry] = entries_.front();
    if (entry.dirty && !entry.ephemeral) {
      writeBack(key, entry);
    }
    entries_.pop_front();
  }

  void eraseLocked(const std::string& key) noexcept {
    entries_.remove_if([&](const auto& item) { return item.first == key; });
  }

  [[nodiscard]] uint64_t totalBytesLocked() const noexcept {
    uint64_t total = 0;
    for (const auto& item : entries_) {
      total += item.second.bytes();
    }
    return total;
  }

  mutable std::mutex mutex_;
  std::list<std::pair<std::string, SlotStateCacheEntry>> entries_;
  const uint64_t budget_;
};

} // namespace qvac_lib_inference_addon_llama::batching
