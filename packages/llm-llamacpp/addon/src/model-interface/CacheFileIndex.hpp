#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <optional>
#include <string>
#include <system_error>
#include <unordered_map>
#include <utility>
#include <vector>

#include <llama.h>

#include "CacheLedger.hpp"
#include "CacheSourceSelection.hpp"

namespace qvac_lib_inference_addon_llama::cache {

/// The cacheKey files this process has used, with the ledgers their headers
/// carry, so a request can start from the file that shares the most of its
/// prompt. Only paths a request or `saveCache` named are known: the addon
/// never scans directories. A file is read again when its size or
/// modification time changes; one that is missing, empty or in another
/// format, or that failed to load, is skipped until it is written. The
/// ledgers kept are bounded in bytes as well as in files; the files named or
/// matched least recently are forgotten first. Thread-safe.
class CacheFileIndex {
public:
  /// Paths kept at most; the least recently noted one is forgotten first.
  static constexpr size_t MAX_FILES = 256;
  /// Bytes of ledgers kept in memory at most; the files noted least recently
  /// are forgotten first, and one file is kept even if it alone is larger.
  static constexpr size_t MAX_LEDGER_BYTES = size_t{64} << 20;
  /// Ledger words read from a header at most (a 1M-token context).
  static constexpr size_t MAX_LEDGER_WORDS =
      LEDGER_HEADER_WORDS + LEDGER_ENTRY_WORDS * ((size_t{1} << 20) + 1);

  struct Match {
    std::string path;
    size_t reusable = 0;
    // Ledger words read from the file's header.
    std::vector<llama_token> words;
  };

  explicit CacheFileIndex(size_t maxLedgerBytes = MAX_LEDGER_BYTES)
      : maxLedgerBytes_(maxLedgerBytes) {}

  /// Remembers `path` as a cacheKey file of this model.
  void note(const std::string& path) {
    if (path.empty()) {
      return;
    }
    std::scoped_lock lock(mutex_);
    files_[path].lastNoted = ++clock_;
    while (files_.size() > MAX_FILES) {
      auto oldest = files_.begin();
      for (auto it = files_.begin(); it != files_.end(); ++it) {
        if (it->second.lastNoted < oldest->second.lastNoted) {
          oldest = it;
        }
      }
      files_.erase(oldest);
    }
  }

  /// The file other than `excluded` with the longest `reusablePrefix` of
  /// `prompt`, which counts as noted again. Files carry no checkpoints here,
  /// so on memory that cannot be trimmed only a file whose state is a prefix
  /// of `prompt` serves. Files are read newest first, and none once the
  /// ledgers read pass the byte budget: the older ones are forgotten.
  [[nodiscard]] std::optional<Match> longestPrefix(
      const Ledger& prompt, bool trimmable, const std::string& excluded) {
    std::scoped_lock lock(mutex_);
    std::vector<std::pair<const std::string, Known>*> newestFirst;
    newestFirst.reserve(files_.size());
    for (auto& file : files_) {
      newestFirst.push_back(&file);
    }
    std::sort(
        newestFirst.begin(),
        newestFirst.end(),
        [](const auto* a, const auto* b) {
          return a->second.lastNoted > b->second.lastNoted;
        });
    std::optional<Match> best;
    size_t kept = 0;
    for (auto* file : newestFirst) {
      if (kept > maxLedgerBytes_) {
        break;
      }
      auto& [path, known] = *file;
      const bool usable = path != excluded && refreshLocked(path, known);
      kept += known.bytes();
      if (!usable) {
        continue;
      }
      const size_t reusable =
          reusablePrefix(known.ledger, nullptr, prompt, trimmable);
      if (reusable > 0 && (!best.has_value() || reusable > best->reusable)) {
        best = Match{.path = path, .reusable = reusable, .words = {}};
      }
    }
    if (best.has_value()) {
      Known& matched = files_.at(best->path);
      best->words = matched.words;
      matched.lastNoted = ++clock_;
    }
    forgetBeyondBudgetLocked();
    return best;
  }

  /// Skips `path` until it changes: it failed to load as read. Its ledger is
  /// released; its size and modification time tell when it changes.
  void markUnusable(const std::string& path) {
    std::scoped_lock lock(mutex_);
    if (auto it = files_.find(path); it != files_.end()) {
      it->second.unusable = true;
      it->second.words = {};
      it->second.ledger = {};
    }
  }

  /// Loads `path` into `seqId` and checks that its ledger is `expected`.
  /// False when the load failed or the file was rewritten since it was read;
  /// the caller then clears the sequence.
  static bool loadInto(
      llama_context* lctx, llama_seq_id seqId, const std::string& path,
      const std::vector<llama_token>& expected) {
    std::vector<llama_token> words(expected.size() + 1);
    size_t count = 0;
    if (llama_state_seq_load_file(
            lctx, path.c_str(), seqId, words.data(), words.size(), &count) ==
        0) {
      return false;
    }
    words.resize(count);
    return words == expected;
  }

  /// The ledger words in the header `llama_state_seq_save_file` writes:
  /// magic, version, word count, words. Nothing when the file is not a
  /// current-format cacheKey file.
  static std::optional<std::vector<llama_token>>
  readLedgerWords(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    uint32_t header[3] = {};
    if (!in.read(reinterpret_cast<char*>(header), sizeof(header)) ||
        header[0] != LLAMA_STATE_SEQ_MAGIC ||
        header[1] != LLAMA_STATE_SEQ_VERSION || header[2] > MAX_LEDGER_WORDS) {
      return std::nullopt;
    }
    std::vector<llama_token> words(header[2]);
    if (!in.read(
            reinterpret_cast<char*>(words.data()),
            static_cast<std::streamsize>(words.size() * sizeof(llama_token))) ||
        !hasMarker(words.data(), words.size())) {
      return std::nullopt;
    }
    return words;
  }

  [[nodiscard]] size_t size() const {
    std::scoped_lock lock(mutex_);
    return files_.size();
  }

  /// Bytes of the ledgers kept.
  [[nodiscard]] size_t ledgerBytes() const {
    std::scoped_lock lock(mutex_);
    return ledgerBytesLocked();
  }

private:
  struct Known {
    uint64_t lastNoted = 0;
    bool read = false;
    // The file as read failed to load (see `markUnusable`).
    bool unusable = false;
    uintmax_t size = 0;
    std::filesystem::file_time_type mtime;
    std::vector<llama_token> words;
    Ledger ledger;

    [[nodiscard]] size_t bytes() const {
      return words.size() * sizeof(llama_token) +
             ledger.entries.size() * sizeof(Entry);
    }
  };

  [[nodiscard]] size_t ledgerBytesLocked() const {
    size_t total = 0;
    for (const auto& [path, known] : files_) {
      total += known.bytes();
    }
    return total;
  }

  /// Forgets the least recently noted files until the ledgers kept fit in
  /// `maxLedgerBytes_`, keeping at least the most recently noted one.
  void forgetBeyondBudgetLocked() {
    size_t total = ledgerBytesLocked();
    while (total > maxLedgerBytes_ && files_.size() > 1) {
      auto oldest = files_.begin();
      for (auto it = files_.begin(); it != files_.end(); ++it) {
        if (it->second.lastNoted < oldest->second.lastNoted) {
          oldest = it;
        }
      }
      total -= oldest->second.bytes();
      files_.erase(oldest);
    }
  }

  /// Reads `path` again when its size or modification time changed. False,
  /// with the ledger it held released, when it is gone, empty or not a
  /// current-format cacheKey file.
  static bool refreshLocked(const std::string& path, Known& known) {
    const auto unreadable = [&known]() {
      known.read = false;
      known.words = {};
      known.ledger = {};
      return false;
    };
    std::error_code sizeEc;
    std::error_code timeEc;
    const auto size = std::filesystem::file_size(path, sizeEc);
    const auto mtime = std::filesystem::last_write_time(path, timeEc);
    if (sizeEc || timeEc || size == 0) {
      return unreadable();
    }
    if (known.read && size == known.size && mtime == known.mtime) {
      return !known.unusable;
    }
    known.unusable = false;
    auto words = readLedgerWords(path);
    if (!words.has_value()) {
      return unreadable();
    }
    try {
      known.ledger = deserialize(words->data(), words->size()).ledger;
    } catch (const std::exception&) {
      return unreadable();
    }
    known.words = std::move(*words);
    known.size = size;
    known.mtime = mtime;
    known.read = true;
    return true;
  }

  size_t maxLedgerBytes_;
  mutable std::mutex mutex_;
  std::unordered_map<std::string, Known> files_;
  uint64_t clock_ = 0;
};

} // namespace qvac_lib_inference_addon_llama::cache
