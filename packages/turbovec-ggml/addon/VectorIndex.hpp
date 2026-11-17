#pragma once
//
// RAII C++ wrapper around fabric's `ggml_vec_index_t*` C handle. Provides
// typed methods + status-aware accessors over the ggml-base vector-index C API.

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

#include <ggml-vector-index.h>

namespace turbovec_ggml {

enum class VectorStorage : std::uint8_t { F32, Q8, Q4, TurboVecQ4, TurboVecQ2 };

// Parses the JS storage name (`f32`, `q8`, `q4`, `turbovec-q4`,
// `turbovec-q2`). Returns nullopt for anything else.
std::optional<VectorStorage>
parseVectorStorage(std::string_view storage) noexcept;

class VectorIndexFilter {
public:
  explicit VectorIndexFilter(ggml_vec_index_filter_t* handle) noexcept;
  ~VectorIndexFilter();

  VectorIndexFilter(const VectorIndexFilter&) = delete;
  VectorIndexFilter& operator=(const VectorIndexFilter&) = delete;
  VectorIndexFilter(VectorIndexFilter&& other) noexcept;
  VectorIndexFilter& operator=(VectorIndexFilter&& other) noexcept;

  [[nodiscard]] bool valid() const noexcept { return handle_ != nullptr; }
  [[nodiscard]] ggml_vec_index_filter_t* raw() const noexcept {
    return handle_;
  }

private:
  ggml_vec_index_filter_t* handle_;
};

class VectorIndex {
public:
  // Construct a fresh empty index. Throws std::invalid_argument when fabric
  // rejects the dimension, or for TurboVec storage on a 32-bit target.
  VectorIndex(int dim, VectorStorage storage);

  // A first add of at least this many rows to a fresh TurboVec index fits
  // its TQ+ calibration from that batch before encoding it, the rule fabric
  // keeps for indexes loaded from turbovec 0.9 (v3) snapshots. Smaller first
  // batches leave the index uncalibrated.
  static constexpr int AUTO_CALIBRATE_MIN_ROWS = 1000;
  // Rows a first-add calibration fits from: the whole batch up to
  // `autoCalibrateSampleRows(dim)`, otherwise that many rows at an even
  // stride across it. At most this many rows, and at most
  // AUTO_CALIBRATE_MAX_SAMPLE_BYTES of them, so the sample stays bounded
  // up to the 16384 dim cap (1024 rows there).
  static constexpr int AUTO_CALIBRATE_MAX_ROWS = 4096;
  static constexpr size_t AUTO_CALIBRATE_MAX_SAMPLE_BYTES = size_t{64} << 20;
  [[nodiscard]] static constexpr int autoCalibrateSampleRows(int dim) noexcept {
    const size_t rows =
        AUTO_CALIBRATE_MAX_SAMPLE_BYTES /
        (static_cast<size_t>(dim > 0 ? dim : 1) * sizeof(float));
    return static_cast<int>(std::clamp<size_t>(
        rows,
        static_cast<size_t>(AUTO_CALIBRATE_MIN_ROWS),
        static_cast<size_t>(AUTO_CALIBRATE_MAX_ROWS)));
  }

  // Adopt an already-opened native handle (used by static load).
  explicit VectorIndex(ggml_vec_index_t* handle) noexcept;

  ~VectorIndex();

  VectorIndex(const VectorIndex&) = delete;
  VectorIndex& operator=(const VectorIndex&) = delete;
  VectorIndex(VectorIndex&& other) noexcept;
  VectorIndex& operator=(VectorIndex&& other) noexcept;

  // Returns 0 on success, ggml_vec_index_error on failure (e.g. duplicate).
  // The first add to a fresh TurboVec index may calibrate it first, see
  // AUTO_CALIBRATE_MIN_ROWS.
  int add(const float* vectors, int n, const uint64_t* ids) noexcept;

  // True when a TurboVec index holds a TQ+ calibration.
  [[nodiscard]] bool calibrated() const noexcept;

  // Staged search is off for every index this wrapper creates or loads:
  // fabric turns it on by default, as upstream does, but its shortlist
  // loses recall at small k. Returns E_INVALID_ARG for a non-TurboVec index.
  int setStaged(bool enabled) noexcept;
  [[nodiscard]] bool staged() const noexcept { return staged_; }

  int addLogged(
      const float* vectors, int n, const uint64_t* ids,
      const std::string& deltaPath) noexcept;

  // Returns GGML_VEC_INDEX_OK when removed, E_NOT_FOUND when absent.
  int remove(uint64_t id) noexcept;

  int removeLogged(uint64_t id, const std::string& deltaPath) noexcept;

  // Physically removes deleted slots from in-memory storage.
  int compact() noexcept;

  [[nodiscard]] bool contains(uint64_t id) const noexcept;

  void prepare() noexcept;

  int buildIvf(int nLists, int nIter) noexcept;

  // Top-k search. Caller owns out arrays of size nQ * k.
  int search(
      const float* queries, int nQ, int k, float* outScores,
      uint64_t* outIds) const noexcept;

  // Top-k search restricted to the caller-supplied allowlist.
  int searchFiltered(
      const float* queries, int nQ, int k, const uint64_t* allowedIds,
      int nAllowed, float* outScores, uint64_t* outIds) const noexcept;

  // Creates a reusable filter for repeated allowlist searches.
  VectorIndexFilter
  createFilter(const uint64_t* allowedIds, int nAllowed) const noexcept;

  int searchPreparedFiltered(
      const VectorIndexFilter& filter, const float* queries, int nQ, int k,
      float* outScores, uint64_t* outIds) const noexcept;

  int searchIvf(
      const float* queries, int nQ, int k, int nProbe, float* outScores,
      uint64_t* outIds) const noexcept;

  // Persists to disk. Returns 0 on success.
  int write(const std::string& path) noexcept;

  int compactDelta(
      const std::string& snapshotPath, const std::string& deltaPath) noexcept;

  // Reads from disk. On failure returns a wrapper whose `valid()` is false and
  // writes the precise ggml_vec_index_error to status.
  static VectorIndex load(const std::string& path, int* status) noexcept;

  static VectorIndex loadWithDelta(
      const std::string& snapshotPath, const std::string& deltaPath,
      int* status) noexcept;

  // Reads from disk with mmap-backed vector storage. Mutations fail.
  static VectorIndex loadMmap(const std::string& path, int* status) noexcept;

  // Stats.
  [[nodiscard]] int len() const noexcept;
  [[nodiscard]] int dim() const noexcept;
  [[nodiscard]] int bitWidth() const noexcept;

  // True if this instance owns a native handle (i.e. wasn't moved-from /
  // wasn't a failed load).
  [[nodiscard]] bool valid() const noexcept { return handle_ != nullptr; }

  // Raw handle accessor for the JS binding's finalizer. Caller must not
  // free; ownership remains with this object.
  [[nodiscard]] ggml_vec_index_t* raw() const noexcept { return handle_; }

private:
  ggml_vec_index_t* handle_;
  // Set for a fresh TurboVec index until its first add; a loaded index
  // keeps the calibration state it was saved with.
  bool autoCalibrate_ = false;
  bool staged_ = false;
};

} // namespace turbovec_ggml
