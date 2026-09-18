#include <cstdint>
#include <cstring>
#include <string>
#include <tuple>
#include <vector>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>

#include "model-interface/nmt_loader.hpp"

// Property tests over the GGML weight-header parsers extracted in #4590.
// The original crash was `n_dims > 4` writing past `int32_t ne[4]` while
// loading an untrusted model; nearby length fields had the same shape
// (allocate-then-read with no cap). These targets compile the parsers
// without @qvac/fabric so ASan + LeakSanitizer stay at full strength.
// See docs/architecture/ADDON-FUZZING.md.

namespace {

struct BufferReader {
  const uint8_t* data;
  size_t size;
  size_t pos;
};

size_t bufferRead(void* ctx, void* output, size_t read_size) {
  auto* reader = static_cast<BufferReader*>(ctx);
  const size_t remaining = reader->size - reader->pos;
  const size_t to_copy = read_size < remaining ? read_size : remaining;
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

std::vector<uint8_t> leBytes(const std::vector<int32_t>& values) {
  std::vector<uint8_t> bytes(values.size() * sizeof(int32_t));
  if (!values.empty()) {
    std::memcpy(bytes.data(), values.data(), bytes.size());
  }
  return bytes;
}

// The crash in #4590: n_dims is an attacker-controlled loop bound into a
// fixed 4-int stack array. InRange includes 0, 5 and 8 so bounded CI mode
// reaches the reject side without coverage feedback. false is success;
// ASan abort is the finding.
void TensorDimsNeverCrashes(
    int32_t nDims, const std::vector<int32_t>& extents) {
  const std::vector<uint8_t> bytes = leBytes(extents);
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);
  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;
  (void)nmtReadTensorDims(&loader, nDims, ne, nelements);
}
FUZZ_TEST(NmtWeightHeaderFuzz, TensorDimsNeverCrashes)
    .WithDomains(
        fuzztest::InRange<int32_t>(-1, 8),
        fuzztest::VectorOf(fuzztest::Arbitrary<int32_t>()).WithMaxSize(8))
    .WithSeeds([] {
      return std::vector<std::tuple<int32_t, std::vector<int32_t>>>{
          {2, {512, 32322}},
          {4, {2, 3, 4, 5}},
          {8, {0x41414141, 0x41414141, 0x41414141, 0x41414141, 0x41414141,
               0x41414141, 0x41414141, 0x41414141}},
          {0, {1}},
          {-1, {1}},
          {2, {65536, 65536}},
      };
    });

// Same class of bug on the tensor-name / vocab / SentencePiece length
// fields: cap before allocate, and fail a short read rather than
// treating gcount() as success.
void BoundedStringNeverCrashes(
    int64_t length, const std::vector<uint8_t>& payload) {
  BufferReader reader{payload.data(), payload.size(), 0};
  auto loader = makeLoader(reader);
  std::string out;
  (void)nmtReadBoundedString(
      &loader, length, NMT_MAX_TENSOR_NAME_LENGTH, out);
}
FUZZ_TEST(NmtWeightHeaderFuzz, BoundedStringNeverCrashes)
    .WithDomains(
        fuzztest::InRange<int64_t>(-1, NMT_MAX_TENSOR_NAME_LENGTH + 1),
        fuzztest::Arbitrary<std::vector<uint8_t>>().WithMaxSize(64))
    .WithSeeds([] {
      const std::string name = "encoder.embeddings.weight";
      return std::vector<std::tuple<int64_t, std::vector<uint8_t>>>{
          {static_cast<int64_t>(name.size()),
           std::vector<uint8_t>(name.begin(), name.end())},
          {0, {}},
          {-1, {0}},
          {NMT_MAX_TENSOR_NAME_LENGTH + 1, {0}},
          {8, {'a', 'b', 'c', 'd'}},
      };
    });

void ReadCountNeverCrashes(const std::vector<uint8_t>& bytes) {
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);
  int32_t count = 0;
  (void)nmtReadCount(&loader, NMT_MAX_VOCAB_SIZE, count);
}
FUZZ_TEST(NmtWeightHeaderFuzz, ReadCountNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::vector<uint8_t>>().WithMaxSize(16))
    .WithSeeds([] {
      return std::vector<std::tuple<std::vector<uint8_t>>>{
          {leBytes({3})},
          {leBytes({-1})},
          {leBytes({NMT_MAX_VOCAB_SIZE + 1})},
          {std::vector<uint8_t>{0, 0}},
      };
    });

void TensorTypeNeverCrashes(int32_t ttype) {
  (void)nmtIsValidTensorType(ttype);
}
FUZZ_TEST(NmtWeightHeaderFuzz, TensorTypeNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<int32_t>())
    .WithSeeds([] {
      return std::vector<std::tuple<int32_t>>{
          {0},
          {-1},
          {GGML_TYPE_COUNT},
      };
    });

// Seeds only buy coverage if they still do what they claim. The n_dims=8
// case is the #4590 crash: it must be rejected with zero bytes consumed
// and ne[] left intact, or bounded CI silently demotes to the reject
// path of a different branch.
TEST(NmtWeightHeaderFuzzSeeds, MaliciousNDimsIsRejectedWithoutReading) {
  std::vector<int32_t> dims(8, 0x41414141);
  auto bytes = leBytes(dims);
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);
  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;
  EXPECT_FALSE(nmtReadTensorDims(&loader, 8, ne, nelements));
  EXPECT_EQ(reader.pos, 0U);
  EXPECT_EQ(ne[0], 1);
  EXPECT_EQ(ne[1], 1);
  EXPECT_EQ(ne[2], 1);
  EXPECT_EQ(ne[3], 1);
}

TEST(NmtWeightHeaderFuzzSeeds, ValidTwoDimsStillParse) {
  auto bytes = leBytes({512, 32322});
  BufferReader reader{bytes.data(), bytes.size(), 0};
  auto loader = makeLoader(reader);
  int32_t ne[NMT_MAX_TENSOR_DIMS] = {1, 1, 1, 1};
  int32_t nelements = 1;
  EXPECT_TRUE(nmtReadTensorDims(&loader, 2, ne, nelements));
  EXPECT_EQ(ne[0], 512);
  EXPECT_EQ(ne[1], 32322);
  EXPECT_EQ(nelements, 512 * 32322);
}

} // namespace
