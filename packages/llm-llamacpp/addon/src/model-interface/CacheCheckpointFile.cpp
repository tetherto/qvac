#include "CacheCheckpointFile.hpp"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <system_error>
#include <utility>
#include <vector>

#include "utils/LoggingMacros.hpp"
#include "utils/SequenceStateSnapshot.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

namespace qvac_lib_inference_addon_llama::cache {
namespace {

namespace utils = qvac_lib_inference_addon_llama::utils;

// FNV-1a like `hashBytes`, fed piece by piece. The payloads are left out:
// a truncated payload already fails the size checks, and hashing hundreds of
// megabytes would slow every save and load.
class SectionHash {
public:
  void add(const void* data, size_t size) noexcept {
    const auto* bytes = static_cast<const uint8_t*>(data);
    for (size_t i = 0; i < size; ++i) {
      hash_ ^= bytes[i];
      hash_ *= K_PRIME;
    }
  }
  [[nodiscard]] uint64_t value() const noexcept { return hash_; }

private:
  static constexpr uint64_t K_PRIME = 1099511628211ULL;
  uint64_t hash_ = 1469598103934665603ULL;
};

class SectionWriter {
public:
  explicit SectionWriter(std::ofstream& out) : out_(out) {}

  template <typename T> void value(const T& value) {
    raw(&value, sizeof(T));
    hash_.add(&value, sizeof(T));
  }
  void words(const std::vector<llama_token>& words) {
    raw(words.data(), words.size() * sizeof(llama_token));
    hash_.add(words.data(), words.size() * sizeof(llama_token));
  }
  void payload(const std::vector<uint8_t>& bytes) {
    raw(bytes.data(), bytes.size());
  }
  void checksum() {
    const uint64_t sum = hash_.value();
    raw(&sum, sizeof(sum));
  }

private:
  void raw(const void* data, size_t size) {
    out_.write(
        static_cast<const char*>(data), static_cast<std::streamsize>(size));
    if (!out_) {
      throw std::runtime_error("write failed");
    }
  }

  std::ofstream& out_;
  SectionHash hash_;
};

// Reads within the section only: every size is checked against the bytes
// left before anything is allocated, so a corrupt length cannot run past the
// end of the file or allocate an absurd buffer.
class SectionReader {
public:
  SectionReader(std::ifstream& in, uint64_t begin, uint64_t end)
      : in_(in), position_(begin), end_(end) {}

  template <typename T> bool value(T& value) {
    if (!raw(&value, sizeof(T))) {
      return false;
    }
    hash_.add(&value, sizeof(T));
    return true;
  }
  bool words(std::vector<llama_token>& words, uint32_t count) {
    const uint64_t size = static_cast<uint64_t>(count) * sizeof(llama_token);
    if (size > remaining()) {
      return false;
    }
    words.resize(count);
    if (!raw(words.data(), size)) {
      return false;
    }
    hash_.add(words.data(), size);
    return true;
  }
  bool skip(uint64_t size) {
    if (size > remaining()) {
      return false;
    }
    position_ += size;
    in_.seekg(static_cast<std::streamoff>(position_));
    return static_cast<bool>(in_);
  }
  bool checksum(uint64_t& sum) { return raw(&sum, sizeof(sum)); }

  [[nodiscard]] uint64_t position() const noexcept { return position_; }
  [[nodiscard]] uint64_t remaining() const noexcept { return end_ - position_; }
  [[nodiscard]] uint64_t hash() const noexcept { return hash_.value(); }

private:
  bool raw(void* data, uint64_t size) {
    if (size > remaining()) {
      return false;
    }
    in_.read(static_cast<char*>(data), static_cast<std::streamsize>(size));
    if (!in_) {
      return false;
    }
    position_ += size;
    return true;
  }

  std::ifstream& in_;
  uint64_t position_;
  uint64_t end_;
  SectionHash hash_;
};

bool keepable(const Checkpoint& checkpoint) noexcept {
  return checkpoint.state.scope() == utils::SnapshotScope::Partial &&
         checkpoint.state.hasPayload() && checkpoint.state.nPast > 0 &&
         !checkpoint.ledger.entries.empty();
}

void logQuietly(Priority priority, const std::string& message) noexcept {
  try {
    QLOG_IF(priority, message);
  } catch (...) { // NOLINT(bugprone-empty-catch): logging is best effort
  }
}

struct SectionEntry {
  int32_t nPast = 0;
  int32_t cacheTokens = 0;
  std::vector<llama_token> ledgerWords;
  uint64_t payloadOffset = 0;
  uint64_t payloadSize = 0;
};

} // namespace

bool appendCheckpointSection(
    const std::string& path, const Checkpoints& checkpoints) noexcept {
  // Newest last: `appendProcessCheckpoint` adds at the back.
  const auto newest =
      std::find_if(checkpoints.rbegin(), checkpoints.rend(), keepable);
  if (newest == checkpoints.rend()) {
    return true;
  }
  const Checkpoint& checkpoint = *newest;
  std::error_code ec;
  const uintmax_t baseSize = std::filesystem::file_size(path, ec);
  if (ec) {
    return false;
  }
  try {
    const utils::SequenceStateSnapshot& state = checkpoint.state;
    std::vector<uint8_t> fromFile;
    const std::vector<uint8_t>* payload = &state.buffer();
    if (!state.hasBuffer()) {
      if (!utils::readPartialSnapshotPayload(state, fromFile)) {
        throw std::runtime_error("cannot read the checkpoint file");
      }
      payload = &fromFile;
    }
    std::ofstream out(path, std::ios::binary | std::ios::app);
    if (!out) {
      throw std::runtime_error("cannot open the file");
    }
    SectionWriter writer(out);
    writer.value(CHECKPOINT_SECTION_MAGIC);
    writer.value(CHECKPOINT_SECTION_VERSION);
    writer.value(static_cast<uint32_t>(1));
    writer.value(static_cast<int32_t>(state.nPast));
    writer.value(static_cast<int32_t>(checkpoint.cacheTokens));
    const std::vector<llama_token> words = serialize(
        checkpoint.ledger,
        checkpoint.ledger.positions(),
        checkpoint.ledger.cacheTokens());
    writer.value(static_cast<uint32_t>(words.size()));
    writer.words(words);
    writer.value(static_cast<uint64_t>(payload->size()));
    writer.payload(*payload);
    writer.checksum();
    out.close();
    if (!out) {
      throw std::runtime_error("the final flush failed");
    }
    return true;
  } catch (const std::exception& e) {
    std::error_code resizeEc;
    std::filesystem::resize_file(path, baseSize, resizeEc);
    logQuietly(
        Priority::WARNING,
        "[CacheCheckpointFile] the checkpoints were not kept in '" + path +
            "' (" + e.what() + "); it holds the conversation state only\n");
    return false;
  }
}

Checkpoints readCheckpointSection(
    const std::string& path, uint64_t offset, const Ledger& resident,
    const CheckpointPolicy& policy) noexcept {
  if (policy.maxCount == 0) {
    return {};
  }
  const auto reject = [&path](const char* reason) {
    logQuietly(
        Priority::WARNING,
        "[CacheCheckpointFile] ignoring the checkpoints in '" + path +
            "': " + reason + "\n");
    return Checkpoints{};
  };
  try {
    std::error_code ec;
    const uintmax_t size = std::filesystem::file_size(path, ec);
    if (ec || offset >= size) {
      return {};
    }
    std::ifstream in(path, std::ios::binary);
    in.seekg(static_cast<std::streamoff>(offset));
    if (!in) {
      return reject("cannot read the file");
    }
    SectionReader reader(in, offset, size);
    uint32_t magic = 0;
    uint32_t version = 0;
    uint32_t count = 0;
    if (!reader.value(magic) || magic != CHECKPOINT_SECTION_MAGIC) {
      return reject("unrecognized data after the conversation state");
    }
    if (!reader.value(version) || version != CHECKPOINT_SECTION_VERSION) {
      return reject("written by a newer version");
    }
    if (!reader.value(count) || count > MAX_CONFIGURABLE_PROCESS_CHECKPOINTS) {
      return reject("invalid checkpoint count");
    }

    // First pass: the metadata and the checksum, skipping the payloads.
    std::vector<SectionEntry> entries(count);
    for (SectionEntry& entry : entries) {
      uint32_t wordCount = 0;
      if (!reader.value(entry.nPast) || !reader.value(entry.cacheTokens) ||
          !reader.value(wordCount) ||
          !reader.words(entry.ledgerWords, wordCount) ||
          !reader.value(entry.payloadSize)) {
        return reject("truncated");
      }
      entry.payloadOffset = reader.position();
      if (entry.payloadSize == 0 || !reader.skip(entry.payloadSize)) {
        return reject("truncated");
      }
    }
    const uint64_t expected = reader.hash();
    uint64_t stored = 0;
    if (!reader.checksum(stored) || stored != expected) {
      return reject("checksum mismatch");
    }
    if (reader.remaining() != 0) {
      return reject("unexpected data after the checkpoints");
    }

    // Second pass: one payload at a time, oldest first, so the policy trims
    // the list the way it trims new checkpoints.
    Checkpoints result;
    std::vector<uint8_t> payload;
    for (SectionEntry& entry : entries) {
      DecodedLedger decoded;
      try {
        decoded =
            deserialize(entry.ledgerWords.data(), entry.ledgerWords.size());
      } catch (const std::exception&) {
        continue;
      }
      // Usable only on top of the memory loaded from the same file.
      if (decoded.ledger.entries.empty() ||
          entry.nPast != decoded.ledger.positions() ||
          commonPrefix(decoded.ledger, resident) !=
              decoded.ledger.entries.size()) {
        continue;
      }
      payload.resize(entry.payloadSize);
      in.clear();
      in.seekg(static_cast<std::streamoff>(entry.payloadOffset));
      in.read(
          reinterpret_cast<char*>(payload.data()),
          static_cast<std::streamsize>(payload.size()));
      if (!in) {
        return reject("cannot read a checkpoint");
      }
      Checkpoint checkpoint;
      checkpoint.ledger = std::move(decoded.ledger);
      checkpoint.cacheTokens = entry.cacheTokens;
      if (!utils::partialSnapshotFromPayload(
              std::exchange(payload, {}),
              entry.nPast,
              policy.storage,
              policy.directory,
              checkpoint.state)) {
        continue;
      }
      appendProcessCheckpoint(
          result, std::move(checkpoint), policy, [](const Checkpoint& kept) {
            return kept.state.bytes();
          });
    }
    return result;
  } catch (const std::exception& e) {
    return reject(e.what());
  } catch (...) {
    return reject("unexpected error");
  }
}

} // namespace qvac_lib_inference_addon_llama::cache
