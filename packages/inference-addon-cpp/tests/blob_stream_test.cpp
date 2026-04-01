#include <algorithm>
#include <random>
#include <vector>

#include <gtest/gtest.h>

#include "stream_buffers.hpp"

namespace qvac_lib_inference_addon_cpp::test {

class BlobStreamTest : public ::testing::Test {
protected:
  void SetUp() override {
    original_data_.resize(1024);
    for (size_t i = 0; i < original_data_.size(); ++i) {
      original_data_[i] = static_cast<uint8_t>(i % 256);
    }

    // Known seed in order to reproduce execution
    gen_ = std::mt19937(123);
    size_dist_ = std::uniform_int_distribution<>(8, 24);
  }

  std::vector<std::vector<char>>
  split_into_random_blobs(const std::vector<uint8_t>& original_data) {
    std::vector<std::vector<char>> blobs;
    size_t current_pos = 0;

    while (current_pos < original_data.size()) {
      size_t blob_size = std::min(
          static_cast<size_t>(size_dist_(gen_)),
          original_data.size() - current_pos);

      std::vector<char> blob(
          reinterpret_cast<const char*>(original_data.data()) + current_pos,
          reinterpret_cast<const char*>(original_data.data()) + current_pos + blob_size);
      blobs.push_back(std::move(blob));
      current_pos += blob_size;
    }

    return blobs;
  }

  std::vector<uint8_t> original_data_;
  std::mt19937 gen_;
  std::uniform_int_distribution<> size_dist_;
};

TEST_F(BlobStreamTest, RandomSeekAndRead) {
  // Create OwnedBlobsStream with random blobs
  OwnedBlobsStream<char> blobs_stream(
      split_into_random_blobs(original_data_));
  std::basic_istream<char> blobs_istream(&blobs_stream);

  // Create a direct streambuf for comparison - need to copy original_data_ since Uint8BufferStreamBuf takes ownership
  std::vector<uint8_t> original_data_copy = original_data_;
  Uint8BufferStreamBuf direct_buf(std::move(original_data_copy));
  std::basic_istream<char> direct_istream(&direct_buf);

  // Test random seeks and reads
  std::uniform_int_distribution<> pos_dist(0, original_data_.size() - 1);
  std::uniform_int_distribution<> read_size_dist(1, 50);
  std::uniform_int_distribution<> consecutive_reads_dist(0, 10);

  for (int test = 0; test < 100; ++test) {
    size_t seek_pos = pos_dist(gen_);

    size_t read_size = std::min(
        static_cast<size_t>(read_size_dist(gen_)),
        original_data_.size() - seek_pos);

    blobs_istream.clear();
    blobs_istream.seekg(seek_pos);

    direct_istream.clear();
    direct_istream.seekg(seek_pos);

    const int consecutive_reads_gen = consecutive_reads_dist(gen_);
    std::size_t total_read = 0;

    for (int consecutive_read = 0; consecutive_read < consecutive_reads_gen;
         consecutive_read++) {
      std::vector<char> blobs_read(read_size);
      blobs_istream.read(blobs_read.data(), read_size);
      size_t blobs_bytes_read = blobs_istream.gcount();

      std::vector<char> direct_read(read_size);
      direct_istream.read(direct_read.data(), read_size);

      EXPECT_EQ(blobs_bytes_read, static_cast<size_t>(direct_istream.gcount()));
      total_read += read_size;

      for (size_t i = 0; i < blobs_bytes_read; ++i) {
        EXPECT_EQ(static_cast<uint8_t>(blobs_read[i]), static_cast<uint8_t>(direct_read[i]))
            << "Mismatch at position " << i << " in test " << test;
      }
    }
  }
}

TEST_F(BlobStreamTest, EdgeCases) {
  OwnedBlobsStream<char> blobs_stream(
      split_into_random_blobs(original_data_));
  std::basic_istream<char> blobs_istream(&blobs_stream);

  // Test seeking to end
  blobs_istream.clear();
  blobs_istream.seekg(0, std::ios::end);
  std::streampos blobs_istream_size = blobs_istream.tellg();
  size_t original_data_size = original_data_.size();
  EXPECT_EQ(
      blobs_istream_size, static_cast<std::streampos>(original_data_size));

  // Test seeking from current position
  blobs_istream.clear();
  blobs_istream.seekg(100);
  blobs_istream.seekg(50, std::ios::cur);
  EXPECT_EQ(blobs_istream.tellg(), static_cast<std::streampos>(150));

  // Test reading past end
  blobs_istream.clear();
  blobs_istream.seekg(original_data_.size() - 10);
  std::vector<char> end_read(20);
  blobs_istream.read(end_read.data(), 20);
  EXPECT_EQ(blobs_istream.gcount(), 10);
}

TEST_F(BlobStreamTest, SequentialRead) {
  OwnedBlobsStream<char> blobs_stream(
      split_into_random_blobs(original_data_));
  std::basic_istream<char> blobs_istream(&blobs_stream);

  // Read the entire stream sequentially
  std::vector<char> read_data;
  read_data.reserve(original_data_.size());

  std::vector<char> buffer(64); // Read in chunks
  while (blobs_istream.read(buffer.data(), buffer.size())) {
    size_t bytes_read = blobs_istream.gcount();
    read_data.insert(
        read_data.end(), buffer.begin(), buffer.begin() + bytes_read);
  }

  // Add any remaining bytes
  size_t final_bytes = blobs_istream.gcount();
  if (final_bytes > 0) {
    read_data.insert(
        read_data.end(), buffer.begin(), buffer.begin() + final_bytes);
  }

  EXPECT_EQ(read_data.size(), original_data_.size());
  for (size_t i = 0; i < read_data.size(); ++i) {
    EXPECT_EQ(static_cast<uint8_t>(read_data[i]), original_data_[i]);
  }
}

TEST_F(BlobStreamTest, SeekToInvalidPositions) {
  OwnedBlobsStream<char> blobs_stream(
      split_into_random_blobs(original_data_));
  std::basic_istream<char> blobs_istream(&blobs_stream);

  // Test seeking beyond end
  blobs_istream.clear();
  blobs_istream.seekg(original_data_.size() + 100);
  std::streampos result = blobs_istream.tellg();
  EXPECT_EQ(result, std::streampos(-1));

  // Test seeking to negative position
  blobs_istream.clear();
  blobs_istream.seekg(-10);
  result = blobs_istream.tellg();
  EXPECT_EQ(result, std::streampos(-1));
}

TEST_F(BlobStreamTest, EmptyBlobs) {
  std::vector<std::vector<char>> empty_blobs;
  OwnedBlobsStream<char> empty_stream(std::move(empty_blobs));
  std::basic_istream<char> empty_istream(&empty_stream);

  std::vector<char> buffer(10);
  empty_istream.read(buffer.data(), buffer.size());
  EXPECT_EQ(empty_istream.gcount(), 0);
  EXPECT_TRUE(empty_istream.eof());
}

TEST_F(BlobStreamTest, SingleBlob) {
  std::vector<std::vector<char>> single_blob;
  single_blob.emplace_back(reinterpret_cast<const char*>(original_data_.data()),
                           reinterpret_cast<const char*>(original_data_.data()) + original_data_.size());
  OwnedBlobsStream<char> single_stream(std::move(single_blob));
  std::basic_istream<char> single_istream(&single_stream);

  std::vector<char> read_data(original_data_.size());
  single_istream.read(read_data.data(), read_data.size());
  EXPECT_EQ(single_istream.gcount(), original_data_.size());
  for (size_t i = 0; i < read_data.size(); ++i) {
    EXPECT_EQ(static_cast<uint8_t>(read_data[i]), original_data_[i]);
  }
}

TEST_F(BlobStreamTest, MultipleSmallBlobs) {
  std::vector<std::vector<char>> small_blobs;
  for (size_t i = 0; i < original_data_.size(); i += 4) {
    size_t chunk_size =
        std::min(static_cast<size_t>(4), original_data_.size() - i);
    std::vector<char> chunk(
        reinterpret_cast<const char*>(original_data_.data()) + i,
        reinterpret_cast<const char*>(original_data_.data()) + i + chunk_size);
    small_blobs.push_back(std::move(chunk));
  }

  OwnedBlobsStream<char> small_stream(std::move(small_blobs));
  std::basic_istream<char> small_istream(&small_stream);

  std::vector<char> read_data(original_data_.size());
  small_istream.read(read_data.data(), read_data.size());
  EXPECT_EQ(small_istream.gcount(), original_data_.size());
  for (size_t i = 0; i < read_data.size(); ++i) {
    EXPECT_EQ(static_cast<uint8_t>(read_data[i]), original_data_[i]);
  }
}

} // namespace qvac_lib_inference_addon_cpp::test
