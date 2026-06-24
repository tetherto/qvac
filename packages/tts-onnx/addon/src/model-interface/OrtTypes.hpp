#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace qvac::ttslib::chatterbox {

enum class OrtElementType {
  Fp16 = 0,
  Fp32 = 1,
  Fp64 = 2,
  Int4 = 3,
  Int8 = 4,
  Int16 = 5,
  Int32 = 6,
  Int64 = 7,
  UInt4 = 8,
  UInt8 = 9,
  UInt16 = 10,
  UInt32 = 11,
  UInt64 = 12
};

struct OrtTensor {
  void *data;
  std::string name;
  std::vector<int64_t> shape;
  OrtElementType type;
};

} // namespace qvac::ttslib::chatterbox
