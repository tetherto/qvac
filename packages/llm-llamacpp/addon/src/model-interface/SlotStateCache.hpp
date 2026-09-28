#pragma once

#include <cstdint>
#include <iterator>
#include <list>
#include <new>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <llama.h>

#include "CacheLedger.hpp"

namespace qvac_lib_inference_addon_llama::batching {

/// A conversation state moved out of its batch slot: the full sequence state
/// and the ledger that describes it, plus the checkpoints that go with it.
struct SlotStateCacheEntry {
  std::vector<uint8_t> state;
  std::vector<llama_token> ledgerWords;
  cache::Checkpoints checkpoints;
  /// The state was loaded from, or last written to, its `cacheKey` file.
  bool activeCacheSavedToDisk = false;

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

/// Host-RAM tier for batch conversation states (`cache_ram_mib`), keyed by
/// `cacheKey`, oldest first. Entries are clean: a state with unsaved turns is
/// written to its `cacheKey` file before it gets here, so dropping one never
/// loses work, only the fast restore. Mirrors llama-server's
/// `server_prompt_cache::alloc` rules: an entry larger than the whole budget
/// is skipped, a newer entry for the same key replaces the older one, and the
/// oldest entries are evicted until a new one fits. Not thread-safe; the
/// scheduler uses it under its own lock.
class SlotStateCache {
public:
  void setBudget(uint64_t bytes) noexcept { budget_ = bytes; }
  [[nodiscard]] uint64_t budget() const noexcept { return budget_; }
  [[nodiscard]] bool enabled() const noexcept { return budget_ > 0; }

  /// Stores `entry` under `key`. Returns false when it does not fit the
  /// budget even alone; the existing entries are then left untouched.
  bool insert(const std::string& key, SlotStateCacheEntry entry) {
    const uint64_t size = entry.bytes();
    if (!enabled() || size > budget_) {
      return false;
    }
    erase(key);
    while (!entries_.empty() && totalBytes() + size > budget_) {
      entries_.pop_front();
    }
    entries_.emplace_back(key, std::move(entry));
    return true;
  }

  /// Removes and returns the entry for `key`, if any.
  [[nodiscard]] std::optional<SlotStateCacheEntry>
  take(const std::string& key) {
    for (auto it = entries_.begin(); it != entries_.end(); ++it) {
      if (it->first == key) {
        SlotStateCacheEntry entry = std::move(it->second);
        entries_.erase(it);
        return entry;
      }
    }
    return std::nullopt;
  }

  void erase(const std::string& key) noexcept {
    entries_.remove_if([&](const auto& item) { return item.first == key; });
  }

  void clear() noexcept { entries_.clear(); }

  [[nodiscard]] size_t size() const noexcept { return entries_.size(); }

  [[nodiscard]] uint64_t totalBytes() const noexcept {
    uint64_t total = 0;
    for (const auto& item : entries_) {
      total += item.second.bytes();
    }
    return total;
  }

private:
  std::list<std::pair<std::string, SlotStateCacheEntry>> entries_;
  uint64_t budget_ = 0;
};

} // namespace qvac_lib_inference_addon_llama::batching
