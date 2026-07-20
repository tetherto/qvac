#include "MediaLoadOrder.hpp"

#include <inference-addon-cpp/Errors.hpp>

#include "addon/LlmErrors.hpp"

using namespace qvac_lib_inference_addon_llama::errors;

void validateByteBufferCount(
    const std::vector<PlannedMedia>& plan, size_t bufferCount) {
  size_t required = 0;
  for (const auto& pm : plan) {
    if (pm.source == MediaSource::ByteBuffer) {
      required++;
    }
  }
  if (required != bufferCount) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(qvac_errors::general_error::InvalidArgument),
        "media buffer count does not match byte-buffer media markers in the "
        "prompt");
  }
}

std::vector<MediaLoadStep>
computeMediaLoadOrder(const std::vector<PlannedMedia>& plan) {
  std::vector<MediaLoadStep> steps;
  steps.reserve(plan.size());

  size_t byteIndex = 0;
  for (const auto& item : plan) {
    if (item.source == MediaSource::ByteBuffer) {
      steps.push_back({MediaSource::ByteBuffer, byteIndex++, ""});
    } else {
      steps.push_back({MediaSource::Path, 0, item.path});
    }
  }

  return steps;
}
