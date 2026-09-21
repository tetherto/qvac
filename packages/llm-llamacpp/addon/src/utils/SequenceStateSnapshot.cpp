#include "SequenceStateSnapshot.hpp"

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <string>
#include <system_error>
#include <utility>

#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif

#include <llama.h>

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
      captured_(other.captured_) {
  other.filePath_.clear();
  other.nPast = 0;
  other.captured_ = false;
}

SequenceStateSnapshot&
SequenceStateSnapshot::operator=(SequenceStateSnapshot&& other) noexcept {
  if (this != &other) {
    removeFileQuiet(filePath_);
    filePath_ = std::move(other.filePath_);
    nPast = other.nPast;
    captured_ = other.captured_;
    other.filePath_.clear();
    other.nPast = 0;
    other.captured_ = false;
  }
  return *this;
}

void SequenceStateSnapshot::clear() noexcept {
  removeFileQuiet(filePath_);
  filePath_.clear();
  nPast = 0;
  captured_ = false;
}

void SequenceStateSnapshot::seedForTesting(
    std::string filePath, llama_pos nPastAt) noexcept {
  removeFileQuiet(filePath_);
  filePath_ = std::move(filePath);
  nPast = nPastAt;
  captured_ = true;
}

void SequenceStateSnapshot::seedEmptyForTesting(llama_pos nPastAt) noexcept {
  removeFileQuiet(filePath_);
  filePath_.clear();
  nPast = nPastAt;
  captured_ = true;
}

void SequenceStateSnapshot::adoptFile(
    std::string filePath, llama_pos nPastAt) noexcept {
  removeFileQuiet(filePath_);
  filePath_ = std::move(filePath);
  nPast = nPastAt;
  captured_ = true;
}

void SequenceStateSnapshot::adoptEmpty(llama_pos nPastAt) noexcept {
  removeFileQuiet(filePath_);
  filePath_.clear();
  nPast = nPastAt;
  captured_ = true;
}

// ---- Free functions ----

bool snapshotSequenceState(
    ::llama_context* lctx, llama_seq_id seqId, llama_pos nPastAt,
    SequenceStateSnapshot& out) {
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
    return true;
  }

  // Write the full state (KV + recurrent) to a temp file via
  // `llama_state_seq_save_file`. Internally this calls
  // `state_seq_write_data(io, seq_id, /*flags=*/0)`, llama.cpp's
  // full-state sequence path. We do not save any prompt tokens
  // alongside the state; those are recovered from `nPast` /
  // `postReasoningTokens_` at restore time.
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

  out.adoptFile(std::move(path), nPastAt);
  snapshotFilesWritten().fetch_add(1, std::memory_order_relaxed);
  return true;
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
