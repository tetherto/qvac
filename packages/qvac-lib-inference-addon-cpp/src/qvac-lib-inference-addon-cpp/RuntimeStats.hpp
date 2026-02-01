#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <variant>

namespace qvac_lib_inference_addon_cpp {

using RuntimeStats  = std::vector<std::pair<std::string, std::variant<double,int64_t>>>;
}
