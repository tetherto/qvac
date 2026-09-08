#pragma once

#include <cstdint>
#include <string>

namespace qvac::audiogenggml {

struct AudioGenProgress {
  std::string stage;
  int64_t step = 0;
  int64_t total = 0;
};

} // namespace qvac::audiogenggml
