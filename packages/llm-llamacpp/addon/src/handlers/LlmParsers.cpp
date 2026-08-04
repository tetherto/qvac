#include "handlers/LlmParsers.hpp"

#include <charconv>
#include <cmath>
#include <limits>

#include <inference-addon-cpp/Errors.hpp>

#include "addon/LlmErrors.hpp"

namespace qvac_lib_inference_addon_llama::parsers {

int parseReasoningBudgetConfig(std::string_view raw) {
  int value = 0;
  const char* begin = raw.data();
  const char* end = begin + raw.size();
  const auto [ptr, ec] = std::from_chars(begin, end, value);
  if (ec != std::errc{} || ptr != end || value < -1) {
    throw qvac_errors::StatusError(
        errors::ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "reasoning-budget must be -1 (unrestricted), 0 (disabled), or a "
        "positive integer (token cap)");
  }
  return value;
}

int validateReasoningBudgetOverride(double raw) {
  if (raw < -1 || raw != std::floor(raw) ||
      raw > static_cast<double>(std::numeric_limits<int>::max())) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "generationParams.reasoning_budget must be -1 (unrestricted), "
        "0 (disabled), or a positive integer (token cap)");
  }
  return static_cast<int>(raw);
}

} // namespace qvac_lib_inference_addon_llama::parsers
