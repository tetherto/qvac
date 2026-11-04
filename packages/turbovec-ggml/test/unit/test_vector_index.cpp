#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <limits>
#include <random>
#include <stdexcept>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

#include <gtest/gtest.h>

#include "VectorIndex.hpp"
#include "VectorIndexErrors.hpp"

using turbovec_ggml::parseVectorStorage;
using turbovec_ggml::VectorIndex;
using turbovec_ggml::VectorIndexFilter;
using turbovec_ggml::VectorStorage;
namespace verrors = turbovec_ggml::vector_index_errors;

namespace {

constexpr int DIM = 16;

std::vector<float> unitVec(int i) {
  std::vector<float> vector(DIM, 0.0F);
  vector[i] = 1.0F;
  return vector;
}

// `n` Gaussian rows with ids 1..n, a sample TQ+ can fit.
struct Batch {
  std::vector<float> vectors;
  std::vector<uint64_t> ids;
};

Batch gaussianBatch(int n, uint64_t firstId = 1, unsigned seed = 7) {
  std::mt19937 gen(seed);
  std::normal_distribution<float> dist(0.0F, 1.0F);
  Batch batch;
  batch.vectors.resize(static_cast<size_t>(n) * DIM);
  for (float& x : batch.vectors) {
    x = dist(gen);
  }
  for (int i = 0; i < n; i++) {
    batch.ids.push_back(firstId + static_cast<uint64_t>(i));
  }
  return batch;
}

constexpr bool TURBOVEC_TARGET = sizeof(size_t) >= 8;

// A unique path in the temp dir, removed on scope exit even when an ASSERT
// returns early, so concurrent or failed runs never see each other's files.
class TempFile {
public:
  explicit TempFile(const std::string& name) {
    std::random_device device;
    const auto stamp =
        std::chrono::steady_clock::now().time_since_epoch().count();
    path_ = (std::filesystem::temp_directory_path() /
             (name + "-" + std::to_string(stamp) + "-" +
              std::to_string(device()) + ".tvim"))
                .string();
  }
  ~TempFile() {
    std::error_code ignored;
    std::filesystem::remove(path_, ignored);
  }

  TempFile(const TempFile&) = delete;
  TempFile& operator=(const TempFile&) = delete;
  TempFile(TempFile&&) = delete;
  TempFile& operator=(TempFile&&) = delete;

  [[nodiscard]] const std::string& path() const noexcept { return path_; }

private:
  std::string path_;
};

} // namespace

TEST(VectorIndexTest, ParsesEveryStorageName) {
  EXPECT_EQ(parseVectorStorage("f32"), VectorStorage::F32);
  EXPECT_EQ(parseVectorStorage("q8"), VectorStorage::Q8);
  EXPECT_EQ(parseVectorStorage("q4"), VectorStorage::Q4);
  EXPECT_EQ(parseVectorStorage("turbovec-q4"), VectorStorage::TurboVecQ4);
  EXPECT_EQ(parseVectorStorage("turbovec-q2"), VectorStorage::TurboVecQ2);
  EXPECT_FALSE(parseVectorStorage("").has_value());
  EXPECT_FALSE(parseVectorStorage("q16").has_value());
  EXPECT_FALSE(parseVectorStorage("F32").has_value());
}

TEST(VectorIndexTest, CreatesEveryStorageModeWithItsBitWidth) {
  struct Case {
    VectorStorage storage;
    int bitWidth;
  };
  const std::vector<Case> cases = {
      {VectorStorage::F32, 32},
      {VectorStorage::Q8, 8},
      {VectorStorage::Q4, 4},
      {VectorStorage::TurboVecQ4, 4},
      {VectorStorage::TurboVecQ2, 2}};
  for (const auto& c : cases) {
    const VectorIndex idx(128, c.storage);
    EXPECT_TRUE(idx.valid()) << c.bitWidth;
    EXPECT_EQ(idx.bitWidth(), c.bitWidth);
    EXPECT_EQ(idx.dim(), 128);
    EXPECT_EQ(idx.len(), 0);
  }
}

TEST(VectorIndexTest, RejectsDimensionsFabricRefuses) {
  EXPECT_THROW(VectorIndex(0, VectorStorage::F32), std::invalid_argument);
  EXPECT_THROW(
      VectorIndex(12, VectorStorage::TurboVecQ2), std::invalid_argument);
  EXPECT_THROW(
      VectorIndex(16392, VectorStorage::TurboVecQ4), std::invalid_argument);
}

TEST(VectorIndexTest, MoveTransfersOwnership) {
  VectorIndex source(DIM, VectorStorage::F32);
  ggml_vec_index_t* raw = source.raw();

  VectorIndex moved(std::move(source));
  EXPECT_FALSE(source.valid()); // NOLINT(bugprone-use-after-move)
  EXPECT_EQ(moved.raw(), raw);

  VectorIndex assigned(DIM, VectorStorage::Q8);
  assigned = std::move(moved);
  EXPECT_FALSE(moved.valid()); // NOLINT(bugprone-use-after-move)
  EXPECT_EQ(assigned.raw(), raw);
}

TEST(VectorIndexTest, AddSearchRemoveRoundTrip) {
  VectorIndex idx(DIM, VectorStorage::F32);
  std::vector<float> vectors;
  std::vector<uint64_t> ids;
  for (int i = 0; i < 4; i++) {
    const auto v = unitVec(i);
    vectors.insert(vectors.end(), v.begin(), v.end());
    ids.push_back(100 + i);
  }
  ASSERT_EQ(idx.add(vectors.data(), 4, ids.data()), GGML_VEC_INDEX_OK);
  EXPECT_EQ(idx.len(), 4);
  EXPECT_EQ(idx.add(vectors.data(), 1, ids.data()), GGML_VEC_INDEX_E_DUPLICATE);

  float score = 0.0F;
  uint64_t id = 0;
  const auto query = unitVec(2);
  ASSERT_EQ(idx.search(query.data(), 1, 1, &score, &id), GGML_VEC_INDEX_OK);
  EXPECT_EQ(id, 102U);

  EXPECT_TRUE(idx.contains(102));
  EXPECT_EQ(idx.remove(102), GGML_VEC_INDEX_OK);
  EXPECT_EQ(idx.remove(102), GGML_VEC_INDEX_E_NOT_FOUND);
  EXPECT_FALSE(idx.contains(102));
}

TEST(VectorIndexTest, PreparedFilterRestrictsSearchAndGoesStaleOnMutation) {
  VectorIndex idx(DIM, VectorStorage::F32);
  std::vector<float> vectors;
  std::vector<uint64_t> ids = {1, 2};
  for (int i = 0; i < 2; i++) {
    const auto v = unitVec(i);
    vectors.insert(vectors.end(), v.begin(), v.end());
  }
  ASSERT_EQ(idx.add(vectors.data(), 2, ids.data()), GGML_VEC_INDEX_OK);

  const uint64_t allowed = 2;
  VectorIndexFilter filter = idx.createFilter(&allowed, 1);
  ASSERT_TRUE(filter.valid());

  float score = 0.0F;
  uint64_t id = 0;
  const auto query = unitVec(0);
  ASSERT_EQ(
      idx.searchPreparedFiltered(filter, query.data(), 1, 1, &score, &id),
      GGML_VEC_INDEX_OK);
  EXPECT_EQ(id, 2U);

  ASSERT_EQ(idx.remove(1), GGML_VEC_INDEX_OK);
  EXPECT_EQ(
      idx.searchPreparedFiltered(filter, query.data(), 1, 1, &score, &id),
      GGML_VEC_INDEX_E_INVALID_ARG);
}

TEST(VectorIndexTest, WriteAndLoadRestoresIndex) {
  const TempFile file("turbovec-ggml-unit-roundtrip");
  {
    VectorIndex idx(DIM, VectorStorage::Q8);
    const auto v = unitVec(3);
    const uint64_t id = 7;
    ASSERT_EQ(idx.add(v.data(), 1, &id), GGML_VEC_INDEX_OK);
    ASSERT_EQ(idx.write(file.path()), GGML_VEC_INDEX_OK);
  }

  int status = -1;
  VectorIndex loaded = VectorIndex::load(file.path(), &status);
  ASSERT_EQ(status, GGML_VEC_INDEX_OK);
  ASSERT_TRUE(loaded.valid());
  EXPECT_EQ(loaded.dim(), DIM);
  EXPECT_EQ(loaded.bitWidth(), 8);
  EXPECT_TRUE(loaded.contains(7));
}

TEST(VectorIndexTest, FirstAddOfEnoughRowsCalibratesTurboVec) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  for (const auto storage :
       {VectorStorage::TurboVecQ2, VectorStorage::TurboVecQ4}) {
    VectorIndex idx(DIM, storage);
    EXPECT_FALSE(idx.calibrated());
    const auto batch = gaussianBatch(VectorIndex::AUTO_CALIBRATE_MIN_ROWS);
    ASSERT_EQ(
        idx.add(
            batch.vectors.data(),
            VectorIndex::AUTO_CALIBRATE_MIN_ROWS,
            batch.ids.data()),
        GGML_VEC_INDEX_OK);
    EXPECT_TRUE(idx.calibrated());
    EXPECT_EQ(idx.len(), VectorIndex::AUTO_CALIBRATE_MIN_ROWS);
  }
}

TEST(VectorIndexTest, LargeFirstAddCalibratesFromASpreadSample) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  const int n = VectorIndex::AUTO_CALIBRATE_MAX_ROWS * 2 + 3;
  const int sampleRows = VectorIndex::AUTO_CALIBRATE_MAX_ROWS;
  auto batch = gaussianBatch(n);
  // Rows drift with their position, as a batch in source order can, so a
  // fit from the first rows differs from a fit across the whole batch.
  for (int i = 0; i < n; i++) {
    const float shift = 4.0F * static_cast<float>(i) / static_cast<float>(n);
    for (int d = 0; d < DIM; d++) {
      batch.vectors[static_cast<size_t>(i) * DIM + d] += shift;
    }
  }
  std::vector<float> spread(static_cast<size_t>(sampleRows) * DIM);
  for (int i = 0; i < sampleRows; i++) {
    const auto row = static_cast<size_t>(i) * static_cast<size_t>(n) /
                     static_cast<size_t>(sampleRows);
    std::copy_n(
        batch.vectors.data() + row * DIM,
        DIM,
        spread.data() + static_cast<size_t>(i) * DIM);
  }

  VectorIndex automatic(DIM, VectorStorage::TurboVecQ4);
  VectorIndex expected(DIM, VectorStorage::TurboVecQ4);
  VectorIndex firstRows(DIM, VectorStorage::TurboVecQ4);
  ASSERT_EQ(
      ggml_vec_index_turbovec_calibrate(
          expected.raw(), spread.data(), sampleRows),
      GGML_VEC_INDEX_OK);
  ASSERT_EQ(
      ggml_vec_index_turbovec_calibrate(
          firstRows.raw(), batch.vectors.data(), sampleRows),
      GGML_VEC_INDEX_OK);
  for (VectorIndex* idx : {&automatic, &expected, &firstRows}) {
    ASSERT_EQ(
        idx->add(batch.vectors.data(), n, batch.ids.data()), GGML_VEC_INDEX_OK);
    EXPECT_TRUE(idx->calibrated());
    EXPECT_EQ(idx->len(), n);
  }

  // Equal codes give equal scores bit for bit; the first-rows fit shows the
  // check can tell the two samples apart.
  constexpr int queryCount = 8;
  constexpr int topK = 10;
  const auto queries = gaussianBatch(queryCount, 1, 23);
  auto scoresOf = [&](const VectorIndex& idx) {
    std::vector<float> scores(static_cast<size_t>(queryCount) * topK);
    std::vector<uint64_t> ids(scores.size());
    EXPECT_EQ(
        idx.search(
            queries.vectors.data(),
            queryCount,
            topK,
            scores.data(),
            ids.data()),
        GGML_VEC_INDEX_OK);
    return scores;
  };
  const auto automaticScores = scoresOf(automatic);
  EXPECT_EQ(automaticScores, scoresOf(expected));
  EXPECT_NE(automaticScores, scoresOf(firstRows));
}

TEST(VectorIndexTest, BothSampleBranchesCalibrate) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  // MAX_ROWS fits from the batch itself, one more row from a gathered copy.
  for (const int n :
       {VectorIndex::AUTO_CALIBRATE_MAX_ROWS,
        VectorIndex::AUTO_CALIBRATE_MAX_ROWS + 1}) {
    VectorIndex idx(DIM, VectorStorage::TurboVecQ2);
    const auto batch = gaussianBatch(n);
    ASSERT_EQ(
        idx.add(batch.vectors.data(), n, batch.ids.data()), GGML_VEC_INDEX_OK);
    EXPECT_TRUE(idx.calibrated()) << n << " rows";
  }
}

TEST(VectorIndexTest, RejectedFirstAddLeavesIndexFresh) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  const int n = VectorIndex::AUTO_CALIBRATE_MIN_ROWS * 2;
  VectorIndex idx(DIM, VectorStorage::TurboVecQ4);
  auto batch = gaussianBatch(n);
  batch.ids.back() = batch.ids.front();
  EXPECT_EQ(
      idx.add(batch.vectors.data(), n, batch.ids.data()),
      GGML_VEC_INDEX_E_DUPLICATE);
  EXPECT_EQ(idx.len(), 0);
  EXPECT_FALSE(idx.calibrated());

  batch.ids.back() = static_cast<uint64_t>(n);
  ASSERT_EQ(
      idx.add(batch.vectors.data(), n, batch.ids.data()), GGML_VEC_INDEX_OK);
  EXPECT_TRUE(idx.calibrated());
}

// Fabric checks values only in the rows it calibrates from, but add checks
// every row. A 4097-row batch samples rows 0..4095, so a bad last row is
// seen by add alone.
TEST(VectorIndexTest, FirstAddRejectedForItsValuesLeavesIndexFresh) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  const int n = VectorIndex::AUTO_CALIBRATE_MAX_ROWS + 1;
  ASSERT_GT(n, VectorIndex::autoCalibrateSampleRows(DIM));
  const auto lastValue = static_cast<size_t>(n) * DIM - 1;
  const auto bad = {
      std::numeric_limits<float>::quiet_NaN(),
      std::numeric_limits<float>::infinity(),
      1e16F};
  for (const float value : bad) {
    VectorIndex idx(DIM, VectorStorage::TurboVecQ4);
    auto batch = gaussianBatch(n);
    batch.vectors[lastValue] = value;
    EXPECT_EQ(
        idx.add(batch.vectors.data(), n, batch.ids.data()),
        GGML_VEC_INDEX_E_INVALID_ARG)
        << value;
    EXPECT_EQ(idx.len(), 0) << value;
    EXPECT_FALSE(idx.calibrated()) << value;

    batch.vectors[lastValue] = 0.5F;
    ASSERT_EQ(
        idx.add(batch.vectors.data(), n, batch.ids.data()), GGML_VEC_INDEX_OK);
    EXPECT_TRUE(idx.calibrated()) << value;
  }

  // The JS binding rejects a reserved id before it reaches the wrapper; a
  // direct caller must get the same result.
  const int rows = VectorIndex::AUTO_CALIBRATE_MIN_ROWS;
  VectorIndex idx(DIM, VectorStorage::TurboVecQ4);
  auto batch = gaussianBatch(rows);
  batch.ids.back() = UINT64_MAX;
  EXPECT_NE(
      idx.add(batch.vectors.data(), rows, batch.ids.data()), GGML_VEC_INDEX_OK);
  EXPECT_EQ(idx.len(), 0);
  EXPECT_FALSE(idx.calibrated());
}

TEST(VectorIndexTest, EmptyFirstAddLeavesIndexFresh) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  VectorIndex idx(DIM, VectorStorage::TurboVecQ4);
  const float noVectors[DIM] = {};
  const uint64_t noIds[1] = {};
  ASSERT_EQ(idx.add(noVectors, 0, noIds), GGML_VEC_INDEX_OK);
  EXPECT_FALSE(idx.calibrated());

  const auto batch = gaussianBatch(VectorIndex::AUTO_CALIBRATE_MIN_ROWS);
  ASSERT_EQ(
      idx.add(
          batch.vectors.data(),
          VectorIndex::AUTO_CALIBRATE_MIN_ROWS,
          batch.ids.data()),
      GGML_VEC_INDEX_OK);
  EXPECT_TRUE(idx.calibrated());
}

TEST(VectorIndexTest, FirstBatchFabricCannotFitIsAddedUncalibrated) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  // Every row equal: no spread to fit, so the fit is the identity.
  const int n = VectorIndex::AUTO_CALIBRATE_MIN_ROWS;
  auto batch = gaussianBatch(n);
  for (int i = 1; i < n; i++) {
    std::copy_n(
        batch.vectors.data(),
        DIM,
        batch.vectors.data() + static_cast<size_t>(i) * DIM);
  }
  VectorIndex idx(DIM, VectorStorage::TurboVecQ4);
  ASSERT_EQ(
      idx.add(batch.vectors.data(), n, batch.ids.data()), GGML_VEC_INDEX_OK);
  EXPECT_FALSE(idx.calibrated());
  EXPECT_EQ(idx.len(), n);
}

TEST(VectorIndexTest, FirstAddCalibratesAtMaximumDimension) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  constexpr int maxDim = 16384;
  // One row past the sample, so the gathered-copy branch runs at this dim.
  const int n = VectorIndex::autoCalibrateSampleRows(maxDim) + 1;
  std::mt19937 gen(5);
  std::normal_distribution<float> dist(0.0F, 1.0F);
  std::vector<float> vectors(static_cast<size_t>(n) * maxDim);
  for (float& x : vectors) {
    x = dist(gen);
  }
  std::vector<uint64_t> ids(static_cast<size_t>(n));
  for (int i = 0; i < n; i++) {
    ids[static_cast<size_t>(i)] = static_cast<uint64_t>(i) + 1;
  }
  VectorIndex idx(maxDim, VectorStorage::TurboVecQ4);
  ASSERT_EQ(idx.add(vectors.data(), n, ids.data()), GGML_VEC_INDEX_OK);
  EXPECT_TRUE(idx.calibrated());
  float score = 0.0F;
  uint64_t id = 0;
  ASSERT_EQ(idx.search(vectors.data(), 1, 1, &score, &id), GGML_VEC_INDEX_OK);
  EXPECT_EQ(id, 1U);
}

TEST(VectorIndexTest, CalibrationSampleIsBoundedByDimension) {
  EXPECT_EQ(VectorIndex::autoCalibrateSampleRows(DIM), 4096);
  EXPECT_EQ(VectorIndex::autoCalibrateSampleRows(4096), 4096);
  EXPECT_EQ(VectorIndex::autoCalibrateSampleRows(8192), 2048);
  EXPECT_EQ(VectorIndex::autoCalibrateSampleRows(16384), 1024);
  EXPECT_GE(
      VectorIndex::autoCalibrateSampleRows(16384),
      VectorIndex::AUTO_CALIBRATE_MIN_ROWS);
}

TEST(VectorIndexTest, MoveCarriesFreshTurboVecState) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  const auto batch = gaussianBatch(VectorIndex::AUTO_CALIBRATE_MIN_ROWS);
  VectorIndex source(DIM, VectorStorage::TurboVecQ4);
  VectorIndex moved(std::move(source));
  VectorIndex assigned(DIM, VectorStorage::F32);
  assigned = std::move(moved);
  ASSERT_EQ(
      assigned.add(
          batch.vectors.data(),
          VectorIndex::AUTO_CALIBRATE_MIN_ROWS,
          batch.ids.data()),
      GGML_VEC_INDEX_OK);
  EXPECT_TRUE(assigned.calibrated());
}

TEST(VectorIndexTest, OnlyAFirstAddCalibrates) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  VectorIndex idx(DIM, VectorStorage::TurboVecQ2);
  const int small = VectorIndex::AUTO_CALIBRATE_MIN_ROWS - 1;
  const auto first = gaussianBatch(small);
  ASSERT_EQ(
      idx.add(first.vectors.data(), small, first.ids.data()),
      GGML_VEC_INDEX_OK);
  EXPECT_FALSE(idx.calibrated());
  const auto second =
      gaussianBatch(VectorIndex::AUTO_CALIBRATE_MIN_ROWS, 100000, 11);
  ASSERT_EQ(
      idx.add(
          second.vectors.data(),
          VectorIndex::AUTO_CALIBRATE_MIN_ROWS,
          second.ids.data()),
      GGML_VEC_INDEX_OK);
  EXPECT_FALSE(idx.calibrated());
}

TEST(VectorIndexTest, OtherStoragesAreNeverCalibrated) {
  VectorIndex idx(DIM, VectorStorage::F32);
  const auto batch = gaussianBatch(VectorIndex::AUTO_CALIBRATE_MIN_ROWS);
  ASSERT_EQ(
      idx.add(
          batch.vectors.data(),
          VectorIndex::AUTO_CALIBRATE_MIN_ROWS,
          batch.ids.data()),
      GGML_VEC_INDEX_OK);
  EXPECT_FALSE(idx.calibrated());
}

TEST(VectorIndexTest, LoadedTurboVecKeepsItsCalibrationState) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  const TempFile calibratedFile("turbovec-ggml-unit-calibrated");
  const TempFile plainFile("turbovec-ggml-unit-uncalibrated");
  {
    VectorIndex idx(DIM, VectorStorage::TurboVecQ4);
    const auto batch = gaussianBatch(VectorIndex::AUTO_CALIBRATE_MIN_ROWS);
    ASSERT_EQ(
        idx.add(
            batch.vectors.data(),
            VectorIndex::AUTO_CALIBRATE_MIN_ROWS,
            batch.ids.data()),
        GGML_VEC_INDEX_OK);
    ASSERT_TRUE(idx.calibrated());
    ASSERT_EQ(idx.write(calibratedFile.path()), GGML_VEC_INDEX_OK);
  }
  {
    VectorIndex idx(DIM, VectorStorage::TurboVecQ4);
    const auto batch = gaussianBatch(2);
    ASSERT_EQ(
        idx.add(batch.vectors.data(), 2, batch.ids.data()), GGML_VEC_INDEX_OK);
    ASSERT_EQ(idx.write(plainFile.path()), GGML_VEC_INDEX_OK);
  }
  int status = -1;
  const VectorIndex calibrated =
      VectorIndex::load(calibratedFile.path(), &status);
  ASSERT_EQ(status, GGML_VEC_INDEX_OK);
  EXPECT_TRUE(calibrated.calibrated());

  // A loaded index is not fresh: a large add does not calibrate it.
  VectorIndex plain = VectorIndex::load(plainFile.path(), &status);
  ASSERT_EQ(status, GGML_VEC_INDEX_OK);
  EXPECT_FALSE(plain.calibrated());
  const auto more =
      gaussianBatch(VectorIndex::AUTO_CALIBRATE_MIN_ROWS, 100000, 11);
  ASSERT_EQ(
      plain.add(
          more.vectors.data(),
          VectorIndex::AUTO_CALIBRATE_MIN_ROWS,
          more.ids.data()),
      GGML_VEC_INDEX_OK);
  EXPECT_FALSE(plain.calibrated());
}

TEST(VectorIndexTest, TurboVecStagedSearchIsOffUntilTurnedOn) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  for (const auto storage :
       {VectorStorage::TurboVecQ2, VectorStorage::TurboVecQ4}) {
    VectorIndex idx(DIM, storage);
    EXPECT_FALSE(idx.staged());
    ASSERT_EQ(idx.setStaged(true), GGML_VEC_INDEX_OK);
    EXPECT_TRUE(idx.staged());
    const VectorIndex moved(std::move(idx));
    EXPECT_TRUE(moved.staged());
  }
  VectorIndex idx(DIM, VectorStorage::TurboVecQ4);
  ASSERT_EQ(idx.setStaged(true), GGML_VEC_INDEX_OK);
  ASSERT_EQ(idx.setStaged(false), GGML_VEC_INDEX_OK);
  EXPECT_FALSE(idx.staged());
}

TEST(VectorIndexTest, OtherStoragesRejectStagedSearch) {
  for (const auto storage :
       {VectorStorage::F32, VectorStorage::Q8, VectorStorage::Q4}) {
    VectorIndex idx(DIM, storage);
    EXPECT_EQ(idx.setStaged(true), GGML_VEC_INDEX_E_INVALID_ARG);
    EXPECT_FALSE(idx.staged());
  }
}

TEST(VectorIndexTest, LoadedTurboVecStartsWithStagedSearchOff) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  const TempFile file("turbovec-ggml-unit-staged");
  {
    VectorIndex idx(DIM, VectorStorage::TurboVecQ4);
    ASSERT_EQ(idx.setStaged(true), GGML_VEC_INDEX_OK);
    const auto batch = gaussianBatch(2);
    ASSERT_EQ(
        idx.add(batch.vectors.data(), 2, batch.ids.data()), GGML_VEC_INDEX_OK);
    ASSERT_EQ(idx.write(file.path()), GGML_VEC_INDEX_OK);
  }
  int status = -1;
  const VectorIndex loaded = VectorIndex::load(file.path(), &status);
  ASSERT_EQ(status, GGML_VEC_INDEX_OK);
  EXPECT_FALSE(loaded.staged());
}

// Staged search applies from 32,768 rows at a dimension divisible by 32, and
// only on hosts fabric runs it on. Elsewhere both sides scan in full and the
// comparison holds trivially.
TEST(VectorIndexTest, StagedSearchSettingReachesFabric) {
  if constexpr (!TURBOVEC_TARGET) {
    GTEST_SKIP() << "TurboVec requires a 64-bit target";
  }
  constexpr int dim = 64;
  constexpr int n = 32768;
  constexpr int nq = 64;
  constexpr int k = 10;
  std::mt19937 gen(5);
  std::normal_distribution<float> dist(0.0F, 1.0F);
  std::vector<float> vectors(static_cast<size_t>(n) * dim);
  for (float& x : vectors) {
    x = dist(gen);
  }
  std::vector<uint64_t> ids(n);
  for (int i = 0; i < n; i++) {
    ids[i] = static_cast<uint64_t>(i);
  }
  // A small first batch, so the wrapper does not calibrate and both sides
  // hold the same codes.
  const auto addAll = [&](auto&& add) {
    ASSERT_EQ(add(vectors.data(), 1, ids.data()), GGML_VEC_INDEX_OK);
    ASSERT_EQ(
        add(vectors.data() + dim, n - 1, ids.data() + 1), GGML_VEC_INDEX_OK);
  };
  const std::vector<float> queries(
      vectors.begin(), vectors.begin() + static_cast<ptrdiff_t>(nq) * dim);

  VectorIndex wrapped(dim, VectorStorage::TurboVecQ4);
  addAll([&](const float* v, int m, const uint64_t* i) {
    return wrapped.add(v, m, i);
  });
  ggml_vec_index_t* raw = ggml_vec_index_create_turbovec_q4(dim);
  ASSERT_NE(raw, nullptr);
  addAll([&](const float* v, int m, const uint64_t* i) {
    return ggml_vec_index_add(raw, v, m, i);
  });

  std::vector<float> scoresA(nq * k);
  std::vector<float> scoresB(nq * k);
  std::vector<uint64_t> idsA(nq * k);
  std::vector<uint64_t> idsB(nq * k);
  const auto compare = [&](const VectorIndex& idx, const char* what) {
    ASSERT_EQ(
        idx.search(queries.data(), nq, k, scoresA.data(), idsA.data()),
        GGML_VEC_INDEX_OK);
    ASSERT_EQ(
        ggml_vec_index_search(
            raw, queries.data(), nq, k, scoresB.data(), idsB.data()),
        GGML_VEC_INDEX_OK);
    EXPECT_EQ(idsA, idsB) << what;
  };

  // Fabric's default is staged on; the wrapper's is off.
  ASSERT_EQ(ggml_vec_index_turbovec_set_staged(raw, 0), GGML_VEC_INDEX_OK);
  compare(wrapped, "off by default matches fabric with staged search off");
  // Fabric also turns staged search on for a loaded index, so the adopting
  // constructor has to turn it off again.
  {
    const TempFile file("turbovec-ggml-unit-staged-load");
    ASSERT_EQ(wrapped.write(file.path()), GGML_VEC_INDEX_OK);
    int status = -1;
    const VectorIndex loaded = VectorIndex::load(file.path(), &status);
    ASSERT_EQ(status, GGML_VEC_INDEX_OK);
    compare(loaded, "loaded matches fabric with staged search off");
  }
  ASSERT_EQ(wrapped.setStaged(true), GGML_VEC_INDEX_OK);
  ASSERT_EQ(ggml_vec_index_turbovec_set_staged(raw, 1), GGML_VEC_INDEX_OK);
  compare(wrapped, "turned on matches fabric with staged search on");
  ggml_vec_index_free(raw);
}

TEST(VectorIndexTest, LoadFailureReportsStatusWithoutHandle) {
  const TempFile missing("turbovec-ggml-unit-missing");
  int status = GGML_VEC_INDEX_OK;
  VectorIndex loaded = VectorIndex::load(missing.path(), &status);
  EXPECT_EQ(status, GGML_VEC_INDEX_E_IO);
  EXPECT_FALSE(loaded.valid());
}

TEST(VectorIndexErrorsTest, MapsEveryFabricErrorCode) {
  EXPECT_STREQ(verrors::toString(verrors::VecIndexError::Ok), "OK");
  EXPECT_STREQ(
      verrors::toString(verrors::VecIndexError::InvalidArgument),
      "InvalidArgument");
  EXPECT_STREQ(
      verrors::toString(verrors::VecIndexError::Duplicate), "DuplicateId");
  EXPECT_STREQ(verrors::toString(verrors::VecIndexError::NotFound), "NotFound");
  EXPECT_STREQ(verrors::toString(verrors::VecIndexError::Io), "IOError");
  EXPECT_STREQ(verrors::toString(verrors::VecIndexError::BadMagic), "BadMagic");
  EXPECT_STREQ(
      verrors::toString(verrors::VecIndexError::BadVersion), "BadVersion");
  EXPECT_STREQ(
      verrors::toString(verrors::VecIndexError::OutOfMemory), "OutOfMemory");
  EXPECT_STREQ(
      verrors::toString(verrors::VecIndexError::PartialCompact),
      "PartialCompact");
  EXPECT_STREQ(
      verrors::toString(verrors::VecIndexError::NotDurable), "NotDurable");
  EXPECT_STREQ(
      verrors::toString(verrors::VecIndexError::Internal), "InternalError");
  EXPECT_STREQ(
      verrors::toString(static_cast<verrors::VecIndexError>(-999)),
      "UnknownError");
}
