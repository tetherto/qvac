#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <gtest/gtest.h>

#include "VectorIndex.hpp"
#include "VectorIndexErrors.hpp"

using turbovec_ggml::VectorIndex;
using turbovec_ggml::VectorIndexFilter;
namespace verrors = turbovec_ggml::vector_index_errors;

namespace {

constexpr int DIM = 16;

std::vector<float> unitVec(int i) {
  std::vector<float> vector(DIM, 0.0F);
  vector[i] = 1.0F;
  return vector;
}

std::string tmpPath(const std::string& name) {
  return (std::filesystem::temp_directory_path() / (name + ".tvim")).string();
}

} // namespace

TEST(VectorIndexTest, CreatesEveryStorageModeWithItsBitWidth) {
  struct Case {
    const char* storage;
    int bitWidth;
  };
  const std::vector<Case> cases = {
      {"f32", 32},
      {"q8", 8},
      {"q4", 4},
      {"turbovec-q4", 4},
      {"turbovec-q2", 2}};
  for (const auto& c : cases) {
    VectorIndex idx(128, c.bitWidth, c.storage);
    EXPECT_TRUE(idx.valid()) << c.storage;
    EXPECT_EQ(idx.bitWidth(), c.bitWidth) << c.storage;
    EXPECT_EQ(idx.dim(), 128) << c.storage;
    EXPECT_EQ(idx.len(), 0) << c.storage;
  }
}

TEST(VectorIndexTest, RejectsInvalidStorageAndMismatchedBitWidth) {
  EXPECT_THROW(VectorIndex(DIM, 8, "q16"), std::invalid_argument);
  EXPECT_THROW(VectorIndex(DIM, 8, "f32"), std::invalid_argument);
  EXPECT_THROW(VectorIndex(DIM, 4, "turbovec-q2"), std::invalid_argument);
  EXPECT_THROW(VectorIndex(0, 8), std::invalid_argument);
}

TEST(VectorIndexTest, MoveTransfersOwnership) {
  VectorIndex source(DIM, 32, "f32");
  ggml_vec_index_t* raw = source.raw();

  VectorIndex moved(std::move(source));
  EXPECT_FALSE(source.valid()); // NOLINT(bugprone-use-after-move)
  EXPECT_EQ(moved.raw(), raw);

  VectorIndex assigned(DIM, 8, "q8");
  assigned = std::move(moved);
  EXPECT_FALSE(moved.valid()); // NOLINT(bugprone-use-after-move)
  EXPECT_EQ(assigned.raw(), raw);
}

TEST(VectorIndexTest, AddSearchRemoveRoundTrip) {
  VectorIndex idx(DIM, 32, "f32");
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
  VectorIndex idx(DIM, 32, "f32");
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
  const std::string path = tmpPath("turbovec-ggml-unit-roundtrip");
  {
    VectorIndex idx(DIM, 8, "q8");
    const auto v = unitVec(3);
    const uint64_t id = 7;
    ASSERT_EQ(idx.add(v.data(), 1, &id), GGML_VEC_INDEX_OK);
    ASSERT_EQ(idx.write(path), GGML_VEC_INDEX_OK);
  }

  int status = -1;
  VectorIndex loaded = VectorIndex::load(path, &status);
  std::filesystem::remove(path);
  ASSERT_EQ(status, GGML_VEC_INDEX_OK);
  ASSERT_TRUE(loaded.valid());
  EXPECT_EQ(loaded.dim(), DIM);
  EXPECT_EQ(loaded.bitWidth(), 8);
  EXPECT_TRUE(loaded.contains(7));
}

TEST(VectorIndexTest, LoadFailureReportsStatusWithoutHandle) {
  int status = GGML_VEC_INDEX_OK;
  VectorIndex loaded =
      VectorIndex::load(tmpPath("turbovec-ggml-unit-missing"), &status);
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
