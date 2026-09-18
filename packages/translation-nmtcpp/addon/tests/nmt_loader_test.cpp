#include <cstdint>
#include <cstring>
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

}  // namespace

class NmtLoaderDims : public ::testing::Test {
protected:
  static constexpr int32_t VALID_DIM_ROWS = 512;
  static constexpr int32_t VALID_DIM_COLS = 32322;
  static constexpr int32_t MALICIOUS_N_DIMS = 8;
  static constexpr int32_t POISON = 0x41414141;
  static constexpr int32_t SENTINEL = 1;
};

TEST_F(NmtLoaderDims, ReadsValidTwoDimensions) {
  auto bytes = dimsBytes({VALID_DIM_ROWS, VALID_DIM_COLS});
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;

  EXPECT_TRUE(nmt_read_tensor_dims(&loader, 2, ne, nelements));
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

  EXPECT_TRUE(nmt_read_tensor_dims(&loader, NMT_MAX_TENSOR_DIMS, ne, nelements));
  EXPECT_EQ(nelements, 2 * 3 * 4 * 5);
}

TEST_F(NmtLoaderDims, RejectsTooManyDimensionsWithoutReading) {
  std::vector<int32_t> dims(MALICIOUS_N_DIMS, POISON);
  auto bytes = dimsBytes(dims);
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;

  EXPECT_FALSE(nmt_read_tensor_dims(&loader, MALICIOUS_N_DIMS, ne, nelements));
  EXPECT_EQ(reader.pos, 0U);
  EXPECT_EQ(ne[0], SENTINEL);
  EXPECT_EQ(ne[1], SENTINEL);
  EXPECT_EQ(ne[2], SENTINEL);
  EXPECT_EQ(ne[3], SENTINEL);
}

TEST_F(NmtLoaderDims, RejectsZeroAndNegativeDimensions) {
  auto bytes = dimsBytes({POISON});
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);

  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;

  EXPECT_FALSE(nmt_read_tensor_dims(&loader, 0, ne, nelements));
  EXPECT_FALSE(nmt_read_tensor_dims(&loader, -1, ne, nelements));
  EXPECT_EQ(reader.pos, 0U);
}
