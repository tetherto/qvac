#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <optional>
#include <string>
#include <system_error>
#include <unordered_map>
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
/// format, or that failed to load, is skipped until it is written.
/// Thread-safe.
class CacheFileIndex {
public:
  /// Paths kept at most; the least recently noted one is forgotten first.
  static constexpr size_t MAX_FILES = 256;
  /// Ledger words read from a header at most (a 1M-token context).
  static constexpr size_t MAX_LEDGER_WORDS =
      LEDGER_HEADER_WORDS + LEDGER_ENTRY_WORDS * ((size_t{1} << 20) + 1);

  struct Match {
    std::string path;
    size_t reusable = 0;
    // Ledger words read from the file's header.
    std::vector<llama_token> words;
  };

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
  /// `prompt`. Files carry no checkpoints here, so on memory that cannot be
  /// trimmed only a file whose state is a prefix of `prompt` serves.
  [[nodiscard]] std::optional<Match> longestPrefix(
      const Ledger& prompt, bool trimmable, const std::string& excluded) {
    std::scoped_lock lock(mutex_);
    std::optional<Match> best;
    for (auto& [path, known] : files_) {
      if (path == excluded || !refreshLocked(path, known)) {
        continue;
      }
      const size_t reusable =
          reusablePrefix(known.ledger, nullptr, prompt, trimmable);
      if (reusable > 0 && (!best.has_value() || reusable > best->reusable)) {
        best = Match{.path = path, .reusable = reusable, .words = {}};
      }
    }
    if (best.has_value()) {
      best->words = files_.at(best->path).words;
    }
    return best;
  }

  /// Skips `path` until it changes: it failed to load as read.
  void markUnusable(const std::string& path) {
    std::scoped_lock lock(mutex_);
    if (auto it = files_.find(path); it != files_.end()) {
      it->second.unusable = true;
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
  };

  /// Reads `path` again when its size or modification time changed. False
  /// when it is gone, empty or not a current-format cacheKey file.
  static bool refreshLocked(const std::string& path, Known& known) {
    std::error_code sizeEc;
    std::error_code timeEc;
    const auto size = std::filesystem::file_size(path, sizeEc);
    const auto mtime = std::filesystem::last_write_time(path, timeEc);
    if (sizeEc || timeEc || size == 0) {
      known.read = false;
      return false;
    }
    if (known.read && size == known.size && mtime == known.mtime) {
      return !known.unusable;
    }
    known.read = false;
    known.unusable = false;
    auto words = readLedgerWords(path);
    if (!words.has_value()) {
      return false;
    }
    try {
      known.ledger = deserialize(words->data(), words->size()).ledger;
    } catch (const std::exception&) {
      return false;
    }
    known.words = std::move(*words);
    known.size = size;
    known.mtime = mtime;
    known.read = true;
    return true;
  }

  mutable std::mutex mutex_;
  std::unordered_map<std::string, Known> files_;
  uint64_t clock_ = 0;
};

} // namespace qvac_lib_inference_addon_llama::cache
