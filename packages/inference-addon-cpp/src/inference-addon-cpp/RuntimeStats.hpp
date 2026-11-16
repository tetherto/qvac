#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <variant>

namespace qvac_lib_inference_addon_cpp {

using RuntimeStatValue = std::variant<double, int64_t, std::string>;

using RuntimeStats = std::vector<std::pair<std::string, RuntimeStatValue>>;
}
