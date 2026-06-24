#pragma once

#include <cstdint>
#include <string>

namespace qvac_lib_infer_llamacpp_embed::errors {
constexpr const char* ADDON_ID = "GTE";

enum GteErrorCode : std::uint8_t {
  UnableToLoadModel,
  UnableToLoadMetadata,
  InvalidConfiguration,
  UnsupportedEmbeddings,
  InputTokensExceedBatchSize,
  ContextOverflow,
  InvalidArgument,
  FailedToGetTokenEmbeddings,
  FailedToGetSequenceEmbeddings,
  DecodeFailed
};

inline std::string toString(GteErrorCode code)
{
  switch(code)
  {
    case UnableToLoadModel : return "UnableToLoadModel";
    case UnableToLoadMetadata:
      return "UnableToLoadMetadata";
    case InvalidConfiguration : return "InvalidConfiguration";
    case UnsupportedEmbeddings : return "UnsupportedEmbeddings";
    case InputTokensExceedBatchSize : return "InputTokensExceedBatchSize";
    case ContextOverflow:
      return "ContextOverflow";
    case InvalidArgument:
      return "InvalidArgument";
    case FailedToGetTokenEmbeddings:
      return "FailedToGetTokenEmbeddings";
    case FailedToGetSequenceEmbeddings:
      return "FailedToGetSequenceEmbeddings";
    case DecodeFailed:
      return "DecodeFailed";
    default: return "UnknownError";
  }
}

} // namespace qvac_lib_infer_llamacpp_embed::errors

 
