#pragma once

#include <cstdint>
#include <string>

namespace qvac_lib_inference_addon_decision::errors {
constexpr const char* ADDON_ID = "Decision";

enum DecisionErrorCode : std::uint8_t {
  UnableToLoadModel,
  UnableToLoadMetadata,
  InvalidConfiguration,
  DecodeFailed,
  InvalidRequest,
  UnsupportedModel,
};

inline std::string toString(DecisionErrorCode code) {
  switch (code) {
  case UnableToLoadModel:
    return "UnableToLoadModel";
  case UnableToLoadMetadata:
    return "UnableToLoadMetadata";
  case InvalidConfiguration:
    return "InvalidConfiguration";
  case DecodeFailed:
    return "DecodeFailed";
  case InvalidRequest:
    return "InvalidRequest";
  case UnsupportedModel:
    return "UnsupportedModel";
  default:
    return "UnknownError";
  }
}

} // namespace qvac_lib_inference_addon_decision::errors
