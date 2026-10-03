#include "SequenceStateSnapshot.hpp"

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif

#include <llama.h>

#include "common/common.h"

namespace qvac_lib_inference_addon_llama {
namespace utils {

namespace {

uint64_t currentProcessId() noexcept {
#ifdef _WIN32
  return static_cast<uint64_t>(_getpid());
#else
  return static_cast<uint64_t>(::getpid());
#endif
}

// Produce a per-process unique temp file path for a snapshot. PID
// disambiguates across processes, `seqId` disambiguates concurrent
// per-slot snapshots in continuous batching, and the monotonic
// counter disambiguates back-to-back captures within the same slot.
std::string makeUniqueSnapshotPath(llama_seq_id seqId) {
  static std::atomic<uint64_t> counter{0};
  const auto id = counter.fetch_add(1, std::memory_order_relaxed);
  std::error_code ec;
  auto base = std::filesystem::temp_directory_path(ec);
  if (ec) {
    // Falling back to "." keeps the snapshot machinery functional on
    // systems where the temp dir lookup fails; the file is still
    // cleaned up on destruct / clear.
    base = ".";
  }
  const std::string filename = "qvac_llamacpp_seq_" +
                               std::to_string(currentProcessId()) + "_" +
                               std::to_string(static_cast<int>(seqId)) + "_" +
                               std::to_string(id) + ".bin";
  return (base / filename).string();
}

std::atomic<uint64_t>& snapshotFilesWritten() noexcept {
  static std::atomic<uint64_t> count{0};
  return count;
}

llama_state_seq_flags flagsFor(SnapshotScope scope) noexcept {
  return scope == SnapshotScope::Partial ? LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY
                                         : 0;
}

bool writeFile(const std::string& path, const std::vector<uint8_t>& data) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  out.write(
      reinterpret_cast<const char*>(data.data()),
      static_cast<std::streamsize>(data.size()));
  return static_cast<bool>(out);
}

bool readFile(const std::string& path, std::vector<uint8_t>& data) {
  std::ifstream in(path, std::ios::binary | std::ios::ate);
  if (!in) {
    return false;
  }
  const auto size = static_cast<size_t>(in.tellg());
  data.resize(size);
  in.seekg(0);
  in.read(
      reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(size));
  return static_cast<bool>(in);
}

// Best-effort file removal. Used by the snapshot destructor and clear
// path, so it must not throw — a leaked temp file is recoverable, a
// thrown exception inside a destructor is not.
void removeFileQuiet(const std::string& path) noexcept {
  if (path.empty()) {
    return;
  }
  std::error_code ec;
  std::filesystem::remove(path, ec);
}

} // namespace

// ---- SequenceStateSnapshot ----

SequenceStateSnapshot::~SequenceStateSnapshot() { removeFileQuiet(filePath_); }

SequenceStateSnapshot::SequenceStateSnapshot(
    SequenceStateSnapshot&& other) noexcept
    : nPast(other.nPast), filePath_(std::move(other.filePath_)),
      buffer_(std::move(other.buffer_)), bytes_(other.bytes_),
      captured_(other.captured_), scope_(other.scope_) {
  other.filePath_.clear();
  other.buffer_.clear();
  other.bytes_ = 0;
  other.nPast = 0;
  other.captured_ = false;
  other.scope_ = SnapshotScope::Full;
}

SequenceStateSnapshot&
SequenceStateSnapshot::operator=(SequenceStateSnapshot&& other) noexcept {
  if (this != &other) {
    removeFileQuiet(filePath_);
    filePath_ = std::move(other.filePath_);
    buffer_ = std::move(other.buffer_);
    bytes_ = other.bytes_;
    nPast = other.nPast;
    captured_ = other.captured_;
    scope_ = other.scope_;
    other.filePath_.clear();
    other.buffer_.clear();
    other.bytes_ = 0;
    other.nPast = 0;
    other.captured_ = false;
    other.scope_ = SnapshotScope::Full;
  }
  return *this;
}

void SequenceStateSnapshot::clear() noexcept {
  removeFileQuiet(filePath_);
  filePath_.clear();
  buffer_.clear();
  buffer_.shrink_to_fit();
  bytes_ = 0;
  nPast = 0;
  captured_ = false;
  scope_ = SnapshotScope::Full;
}

void SequenceStateSnapshot::seedForTesting(
    std::string filePath, llama_pos nPastAt) noexcept {
  clear();
  filePath_ = std::move(filePath);
  nPast = nPastAt;
  captured_ = true;
}

void SequenceStateSnapshot::seedEmptyForTesting(llama_pos nPastAt) noexcept {
  clear();
  nPast = nPastAt;
  captured_ = true;
}

void SequenceStateSnapshot::adoptFile(
    std::string filePath, llama_pos nPastAt, uint64_t bytes) noexcept {
  clear();
  filePath_ = std::move(filePath);
  bytes_ = bytes;
  nPast = nPastAt;
  captured_ = true;
}

void SequenceStateSnapshot::adoptBuffer(
    std::vector<uint8_t> buffer, llama_pos nPastAt) noexcept {
  clear();
  bytes_ = buffer.size();
  buffer_ = std::move(buffer);
  nPast = nPastAt;
  captured_ = true;
}

void SequenceStateSnapshot::adoptEmpty(llama_pos nPastAt) noexcept {
  clear();
  nPast = nPastAt;
  captured_ = true;
}

// ---- Free functions ----

bool snapshotSequenceState(
    ::llama_context* lctx, llama_seq_id seqId, llama_pos nPastAt,
    SequenceStateSnapshot& out, SnapshotStorage storage, SnapshotScope scope) {
  out.clear();
  if (lctx == nullptr) {
    return false;
  }

  // Empty sequence: there is no committed state worth persisting,
  // but we still need to mark the capture so the rollback machinery
  // can tell "we captured an empty state" apart from "we never
  // captured anything". Restore for this case clears the sequence
  // via `llama_memory_seq_rm`, matching the legacy in-memory variant
  // (where `set_data_ext` on the empty-state bytes effectively reset
  // the recurrent / hybrid memory to its pre-decode shape).
  if (nPastAt <= 0) {
    out.adoptEmpty(nPastAt);
    out.setScope(scope);
    return true;
  }

  if (scope == SnapshotScope::Partial) {
    // There is no file variant of the partial API, so both storages copy the
    // bytes out first; disk storage then writes them to the temp file.
    const auto flags = flagsFor(scope);
    const size_t size = llama_state_seq_get_size_ext(lctx, seqId, flags);
    if (size == 0) {
      return false;
    }
    std::vector<uint8_t> buffer(size);
    const size_t copied = llama_state_seq_get_data_ext(
        lctx, buffer.data(), buffer.size(), seqId, flags);
    if (copied == 0) {
      return false;
    }
    buffer.resize(copied);
    if (storage == SnapshotStorage::Memory) {
      out.adoptBuffer(std::move(buffer), nPastAt);
    } else {
      std::string path = makeUniqueSnapshotPath(seqId);
      if (!writeFile(path, buffer)) {
        removeFileQuiet(path);
        return false;
      }
      out.adoptFile(std::move(path), nPastAt, buffer.size());
      snapshotFilesWritten().fetch_add(1, std::memory_order_relaxed);
    }
    out.setScope(scope);
    return true;
  }

  if (storage == SnapshotStorage::Memory) {
    // Same serialized bytes as the file path below, kept in host memory.
    const size_t size = llama_state_seq_get_size(lctx, seqId);
    if (size == 0) {
      return false;
    }
    std::vector<uint8_t> buffer(size);
    const size_t copied =
        llama_state_seq_get_data(lctx, buffer.data(), buffer.size(), seqId);
    if (copied == 0) {
      return false;
    }
    buffer.resize(copied);
    out.adoptBuffer(std::move(buffer), nPastAt);
    return true;
  }

  // Write the full state (KV + recurrent) to a temp file via
  // `llama_state_seq_save_file`. Internally this calls
  // `state_seq_write_data(io, seq_id, /*flags=*/0)`, llama.cpp's
  // full-state sequence path. We do not save any prompt tokens
  // alongside the state; the ledger lives in the cache transaction.
  std::string path = makeUniqueSnapshotPath(seqId);
  const size_t savedBytes = llama_state_seq_save_file(
      lctx,
      path.c_str(),
      seqId,
      /*tokens=*/nullptr,
      /*n_token_count=*/0);
  if (savedBytes == 0) {
    removeFileQuiet(path);
    return false;
  }

  out.adoptFile(std::move(path), nPastAt, savedBytes);
  snapshotFilesWritten().fetch_add(1, std::memory_order_relaxed);
  return true;
}

uint64_t estimateMaxSequenceStateBytes(
    ::llama_context* lctx, const ::llama_vocab* vocab, uint32_t perSeqTokens,
    SnapshotScope scope) {
  if (lctx == nullptr || vocab == nullptr || perSeqTokens == 0) {
    return 0;
  }
  auto* mem = llama_get_memory(lctx);
  if (mem == nullptr) {
    return 0;
  }
  llama_token probe = llama_vocab_bos(vocab);
  if (probe == LLAMA_TOKEN_NULL) {
    probe = llama_vocab_eos(vocab);
  }
  if (probe == LLAMA_TOKEN_NULL) {
    probe = 0;
  }

  constexpr llama_seq_id kProbeSeq = 0;
  llama_batch batch = llama_batch_init(1, 0, 1);
  const auto decodeAt = [&](llama_pos pos) {
    common_batch_clear(batch);
    common_batch_add(batch, probe, pos, {kProbeSeq}, false);
    return llama_decode(lctx, batch) == 0;
  };

  const auto flags = flagsFor(scope);
  const auto sizeNow = [&]() {
    return llama_state_seq_get_size_ext(lctx, kProbeSeq, flags);
  };
  size_t afterOne = 0;
  size_t afterTwo = 0;
  const bool ok = decodeAt(0) && (afterOne = sizeNow()) > 0 && decodeAt(1) &&
                  (afterTwo = sizeNow()) > 0;
  llama_batch_free(batch);
  // Leave the context exactly as found: empty probe sequence, clean perf
  // counters (runtime stats read them after the first real request).
  llama_synchronize(lctx);
  llama_memory_seq_rm(mem, kProbeSeq, -1, -1);
  llama_perf_context_reset(lctx);

  if (!ok || afterTwo < afterOne) {
    return 0;
  }
  const uint64_t perToken = afterTwo - afterOne;
  const uint64_t fixed = afterOne > perToken ? afterOne - perToken : afterOne;
  return fixed + perToken * static_cast<uint64_t>(perSeqTokens);
}

uint64_t sequenceStateSnapshotFilesWritten() noexcept {
  return snapshotFilesWritten().load(std::memory_order_relaxed);
}

bool restoreSequenceState(
    ::llama_context* lctx, llama_seq_id seqId,
    const SequenceStateSnapshot& snapshot) {
  if (lctx == nullptr) {
    return false;
  }
  if (snapshot.empty()) {
    // No capture recorded — nothing to do.
    return true;
  }
  if (snapshot.scope() == SnapshotScope::Partial && snapshot.hasPayload()) {
    // Put the non-trimmable part back, then drop the attention KV past the
    // snapshot. On hybrid memory the recurrent cell now sits at `nPast - 1`,
    // so the trim is a no-op for it.
    std::vector<uint8_t> fileBytes;
    if (snapshot.hasFile() && !readFile(snapshot.filePath(), fileBytes)) {
      return false;
    }
    const std::vector<uint8_t>& data =
        snapshot.hasBuffer() ? snapshot.buffer() : fileBytes;
    auto* mem = llama_get_memory(lctx);
    return mem != nullptr &&
           llama_state_seq_set_data_ext(
               lctx,
               data.data(),
               data.size(),
               seqId,
               flagsFor(SnapshotScope::Partial)) != 0 &&
           llama_memory_seq_rm(mem, seqId, snapshot.nPast, -1);
  }
  if (snapshot.hasBuffer()) {
    // Memory-backed: `set_data` fully replaces the sequence's attention KV
    // and recurrent state from the host copy.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-const-cast)
    return llama_state_seq_set_data(
               lctx,
               snapshot.buffer().data(),
               snapshot.buffer().size(),
               seqId) != 0;
  }
  if (!snapshot.hasFile()) {
    // Captured-but-empty: rewind the sequence to a clean state. We
    // can't use a file load here (there is no payload), but the
    // sequence-clear primitive is the correct semantic equivalent —
    // both attention KV cells and the recurrent / hybrid hidden
    // state for `seqId` are dropped, so the next decode starts from
    // pos 0 with a virgin memory. Propagate the primitive's result:
    // reporting success after a refused clear would let callers save
    // metadata for an empty sequence while live memory still contains
    // stale recurrent state.
    auto* mem = llama_get_memory(lctx);
    if (mem == nullptr) {
      return false;
    }
    return llama_memory_seq_rm(mem, seqId, -1, -1);
  }
  size_t nTokenCount = 0;
  // Since the change to `llama_state_seq_load_file`: a null
  // `tokens_out` now only peeks the header (token count) and returns
  // WITHOUT restoring the sequence state. Pass a dummy output buffer so
  // the call performs the full restore; our snapshot files always carry
  // n_token_count == 0, so capacity 0 never truncates.
  llama_token tokensDummy = LLAMA_TOKEN_NULL;
  const size_t loadedBytes = llama_state_seq_load_file(
      lctx,
      snapshot.filePath().c_str(),
      seqId,
      /*tokens_out=*/&tokensDummy,
      /*n_token_capacity=*/0,
      &nTokenCount);
  return loadedBytes != 0;
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
