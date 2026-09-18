#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/nmt_loader.hpp"

namespace {

struct BufferReader {
  const uint8_t* data;
  size_t size;
  size_t pos;
};

size_t bufferRead(void* ctx, void* output, size_t read_size) {
  auto* reader = static_cast<BufferReader*>(ctx);
  size_t remaining = reader->size - reader->pos;
  size_t to_copy = read_size < remaining ? read_size : remaining;
  std::memcpy(output, reader->data + reader->pos, to_copy);
  reader->pos += to_copy;
  return to_copy;
}

bool bufferEof(void* ctx) {
  auto* reader = static_cast<BufferReader*>(ctx);
  return reader->pos >= reader->size;
}

void bufferClose(void*) {}

nmt_model_loader makeLoader(BufferReader& reader) {
  nmt_model_loader loader = {};
  loader.context = &reader;
  loader.read = bufferRead;
  loader.eof = bufferEof;
  loader.close = bufferClose;
  return loader;
}

std::vector<uint8_t> dimsBytes(const std::vector<int32_t>& dims) {
  std::vector<uint8_t> bytes(dims.size() * sizeof(int32_t));
  std::memcpy(bytes.data(), dims.data(), bytes.size());
  return bytes;
}

} // namespace

class NmtLoaderDims : public ::testing::Test {
protected:
  static constexpr int32_t VALID_DIM_ROWS = 512;
  static constexpr int32_t VALID_DIM_COLS = 32322;
  static constexpr int32_t MALICIOUS_N_DIMS = 8;
  static constexpr int32_t POISON = 0x41414141;
  static constexpr int32_t SENTINEL = 1;
  static constexpr int32_t OVERFLOW_EXTENT = 65536;
  static constexpr int32_t WRAP_EXTENT = 4194305;
  static constexpr int32_t ZERO_EXTENT = 0;
  static constexpr int32_t NEGATIVE_EXTENT = -1;
};

TEST_F(NmtLoaderDims, ReadsValidTwoDimensions) {
  auto bytes = dimsBytes({VALID_DIM_ROWS, VALID_DIM_COLS});
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;

  EXPECT_TRUE(nmtReadTensorDims(&loader, 2, ne, nelements));
  EXPECT_EQ(ne[0], VALID_DIM_ROWS);
  EXPECT_EQ(ne[1], VALID_DIM_COLS);
  EXPECT_EQ(ne[2], SENTINEL);
  EXPECT_EQ(ne[3], SENTINEL);
  EXPECT_EQ(nelements, VALID_DIM_ROWS * VALID_DIM_COLS);
}

TEST_F(NmtLoaderDims, ReadsMaximumDimensions) {
  auto bytes = dimsBytes({2, 3, 4, 5});
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;

  EXPECT_TRUE(nmtReadTensorDims(&loader, NMT_MAX_TENSOR_DIMS, ne, nelements));
  EXPECT_EQ(nelements, 2 * 3 * 4 * 5);
}

TEST_F(NmtLoaderDims, RejectsTooManyDimensionsWithoutReading) {
  std::vector<int32_t> dims(MALICIOUS_N_DIMS, POISON);
  auto bytes = dimsBytes(dims);
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;

  EXPECT_FALSE(nmtReadTensorDims(&loader, MALICIOUS_N_DIMS, ne, nelements));
  EXPECT_EQ(reader.pos, 0U);
  EXPECT_EQ(ne[0], SENTINEL);
  EXPECT_EQ(ne[1], SENTINEL);
  EXPECT_EQ(ne[2], SENTINEL);
  EXPECT_EQ(ne[3], SENTINEL);
}

TEST_F(NmtLoaderDims, RejectsZeroAndNegativeDimensionCount) {
  auto bytes = dimsBytes({POISON});
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;

  EXPECT_FALSE(nmtReadTensorDims(&loader, 0, ne, nelements));
  EXPECT_FALSE(nmtReadTensorDims(&loader, -1, ne, nelements));
  EXPECT_EQ(reader.pos, 0U);
}

TEST_F(NmtLoaderDims, RejectsNonPositiveExtent) {
  auto zeroBytes = dimsBytes({VALID_DIM_ROWS, ZERO_EXTENT});
  BufferReader zeroReader{zeroBytes.data(), zeroBytes.size(), 0};
  auto zeroLoader = makeLoader(zeroReader);

  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;
  EXPECT_FALSE(nmtReadTensorDims(&zeroLoader, 2, ne, nelements));

  auto negativeBytes = dimsBytes({VALID_DIM_ROWS, NEGATIVE_EXTENT});
  BufferReader negativeReader{negativeBytes.data(), negativeBytes.size(), 0};
  auto negativeLoader = makeLoader(negativeReader);
  EXPECT_FALSE(nmtReadTensorDims(&negativeLoader, 2, ne, nelements));
}

TEST_F(NmtLoaderDims, RejectsExtentProductOverflow) {
  auto bytes = dimsBytes({OVERFLOW_EXTENT, OVERFLOW_EXTENT});
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;

  EXPECT_FALSE(nmtReadTensorDims(&loader, 2, ne, nelements));
}

TEST_F(NmtLoaderDims, RejectsModuloCollisionHeader) {
  auto bytes = dimsBytes({VALID_DIM_ROWS, VALID_DIM_COLS, 1, WRAP_EXTENT});
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;

  EXPECT_FALSE(nmtReadTensorDims(&loader, NMT_MAX_TENSOR_DIMS, ne, nelements));
}

TEST_F(NmtLoaderDims, RejectsTruncatedDimensions) {
  auto bytes = dimsBytes({VALID_DIM_ROWS});
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;

  EXPECT_FALSE(nmtReadTensorDims(&loader, 2, ne, nelements));
}

class NmtLoaderName : public ::testing::Test {
protected:
  static constexpr int32_t NEGATIVE_LENGTH = -1;
  static constexpr int32_t OVER_LIMIT_LENGTH = NMT_MAX_TENSOR_NAME_LENGTH + 1;
};

TEST_F(NmtLoaderName, ReadsValidName) {
  const std::string expected = "encoder.embeddings.weight";
  std::vector<uint8_t> bytes(expected.begin(), expected.end());
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  std::string name;
  EXPECT_TRUE(
      nmtReadTensorName(&loader, static_cast<int32_t>(expected.size()), name));
  EXPECT_EQ(name, expected);
}

TEST_F(NmtLoaderName, RejectsNegativeLength) {
  std::vector<uint8_t> bytes(1, 0);
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  std::string name;
  EXPECT_FALSE(nmtReadTensorName(&loader, NEGATIVE_LENGTH, name));
  EXPECT_EQ(reader.pos, 0U);
}

TEST_F(NmtLoaderName, RejectsOverLimitLength) {
  std::vector<uint8_t> bytes(1, 0);
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  std::string name;
  EXPECT_FALSE(nmtReadTensorName(&loader, OVER_LIMIT_LENGTH, name));
  EXPECT_EQ(reader.pos, 0U);
}

TEST_F(NmtLoaderName, RejectsShortRead) {
  std::vector<uint8_t> bytes(4, 'a');
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  std::string name;
  EXPECT_FALSE(
      nmtReadTensorName(&loader, static_cast<int32_t>(bytes.size()) + 1, name));
}

class NmtLoaderBoundedString : public ::testing::Test {
protected:
  static constexpr int64_t MAX_LENGTH = 8;
};

TEST_F(NmtLoaderBoundedString, ReadsValidBytes) {
  const std::string expected = "abcd";
  std::vector<uint8_t> bytes(expected.begin(), expected.end());
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  std::string out;
  EXPECT_TRUE(nmtReadBoundedString(
      &loader, static_cast<int64_t>(expected.size()), MAX_LENGTH, out));
  EXPECT_EQ(out, expected);
}

TEST_F(NmtLoaderBoundedString, ReadsZeroLengthAsEmpty) {
  std::vector<uint8_t> bytes(1, 'a');
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  std::string out = "stale";
  EXPECT_TRUE(nmtReadBoundedString(&loader, 0, MAX_LENGTH, out));
  EXPECT_TRUE(out.empty());
  EXPECT_EQ(reader.pos, 0U);
}

TEST_F(NmtLoaderBoundedString, RejectsLengthOverMax) {
  std::vector<uint8_t> bytes(16, 'a');
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  std::string out;
  EXPECT_FALSE(nmtReadBoundedString(&loader, MAX_LENGTH + 1, MAX_LENGTH, out));
  EXPECT_EQ(reader.pos, 0U);
}

TEST_F(NmtLoaderBoundedString, RejectsNegativeLength) {
  std::vector<uint8_t> bytes(1, 'a');
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  std::string out;
  EXPECT_FALSE(nmtReadBoundedString(&loader, -1, MAX_LENGTH, out));
  EXPECT_EQ(reader.pos, 0U);
}

TEST_F(NmtLoaderBoundedString, RejectsShortRead) {
  std::vector<uint8_t> bytes(2, 'a');
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  std::string out;
  EXPECT_FALSE(nmtReadBoundedString(
      &loader, static_cast<int64_t>(bytes.size()) + 1, MAX_LENGTH, out));
}

class NmtLoaderCount : public ::testing::Test {
protected:
  static constexpr int32_t MAX_COUNT = 10;
  static constexpr int32_t VALID_COUNT = 3;
  static constexpr int32_t NEGATIVE_COUNT = -1;
};

TEST_F(NmtLoaderCount, ReadsValidCount) {
  auto bytes = dimsBytes({VALID_COUNT});
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t count = 0;
  EXPECT_TRUE(nmtReadCount(&loader, MAX_COUNT, count));
  EXPECT_EQ(count, VALID_COUNT);
}

TEST_F(NmtLoaderCount, RejectsNegativeCount) {
  auto bytes = dimsBytes({NEGATIVE_COUNT});
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t count = 0;
  EXPECT_FALSE(nmtReadCount(&loader, MAX_COUNT, count));
}

TEST_F(NmtLoaderCount, RejectsOverLimitCount) {
  auto bytes = dimsBytes({MAX_COUNT + 1});
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t count = 0;
  EXPECT_FALSE(nmtReadCount(&loader, MAX_COUNT, count));
}

TEST_F(NmtLoaderCount, RejectsTruncatedCount) {
  std::vector<uint8_t> bytes(2, 0);
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t count = 0;
  EXPECT_FALSE(nmtReadCount(&loader, MAX_COUNT, count));
}

TEST(NmtLoaderTensorType, AcceptsKnownType) {
  EXPECT_TRUE(nmtIsValidTensorType(GGML_TYPE_F32));
}

TEST(NmtLoaderTensorType, RejectsNegativeType) {
  EXPECT_FALSE(nmtIsValidTensorType(-1));
}

TEST(NmtLoaderTensorType, RejectsTypeCount) {
  EXPECT_FALSE(nmtIsValidTensorType(GGML_TYPE_COUNT));
}
