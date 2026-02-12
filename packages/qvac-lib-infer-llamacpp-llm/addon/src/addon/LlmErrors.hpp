#pragma once

#include "qvac-lib-inference-addon-cpp/Errors.hpp"

namespace qvac_lib_inference_addon_llama::errors {
constexpr const char* ADDON_ID = "LLM";

enum LlmErrorCode : uint32_t {
  MissingGGUFFile = 1,
  ContextLengthExeeded = 2,
  InvalidContextId = 3,
  NoCpuBackendFound = 4,
  UnableToLoadModel = 5,
  UnableToCreateThreadPool = 6,
  UnableToCreateSamplingSystem = 7,
  NoBackendFound = 8,
  EmptyPrompt = 9,
  InvalidInputFormat = 10,
  EmptyTokenizedInput = 11,
  BigPrompt = 12,
  EncoderFailed = 13,
  ContextOverflow = 14,
  UnableToLoadSessionFile = 15,
  FailedToDecode = 16,
  NoRoleProvided = 17,
  NoContentProvided = 18,
  MediaNotSupported = 19,
  UserMessageNotProvided = 20,
  MediaRequestNotProvided = 21,
  UnableToDeleteThreadPool = 22,
  // mode llm spesific errors here
};

inline std::string toString(LlmErrorCode code) {
  switch (code) {
  case MissingGGUFFile:
    return "MissingGGUFFile";
  case ContextLengthExeeded:
    return "ContextLengthExeeded";
  case InvalidContextId:
    return "InvalidContextId";
  case NoCpuBackendFound:
    return "NoCpuBackendFound";
  case UnableToLoadModel:
    return "UnableToLoadModel";
  case UnableToCreateThreadPool:
    return "UnableToCreateThreadPool";
  case UnableToCreateSamplingSystem:
    return "UnableToCreateSamplingSystem";
  case NoBackendFound:
    return "NoBackendFound";
  case EmptyPrompt:
    return "EmptyPrompt";
  case InvalidInputFormat:
    return "InvalidInputFormat";
  case EmptyTokenizedInput:
    return "EmptyTokenizedInput";
  case BigPrompt:
    return "BigPrompt";
  case EncoderFailed:
    return "EncoderFailed";
  case ContextOverflow:
    return "ContextOverflow";
  case UnableToLoadSessionFile:
    return "UnableToLoadSessionFile";
  case FailedToDecode:
    return "FailedToDecode";
  case NoRoleProvided:
    return "NoRoleProvided";
  case NoContentProvided:
    return "NoContentProvided";
  case MediaNotSupported:
    return "MediaNotSupported";
  case UserMessageNotProvided:
    return "UserMessageNotProvided";
  case MediaRequestNotProvided:
    return "MediaRequestNotProvided";
  default:
    return "UnknownLLMError";
  }
}
} // namespace qvac_lib_inference_addon_llama::errors
