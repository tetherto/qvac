#include <chrono>
#include <cstdint>
#include <filesystem>
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
      VectorIndex(1032, VectorStorage::TurboVecQ4), std::invalid_argument);
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
