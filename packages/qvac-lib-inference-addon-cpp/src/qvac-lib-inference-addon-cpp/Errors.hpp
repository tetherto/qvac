#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>

namespace qvac_errors {

namespace general_error {

constexpr std::string_view GeneralAddonId = "General";

enum GeneralErrorCode : uint32_t {
  OK = 0,
  InvalidArgument = 1,
  ConfigFileNotFound = 2,
  OutOfMemory = 3,
  InternalError = 4,
  JSLibraryError = 5,
};

inline std::string toString(uint32_t code) {
  switch (code) {
  case 0:
    return "OK";
  case 1:
    return "InvalidArgument";
  case 2:
    return "ConfigFileNotFound";
  case 3:
    return "OutOfMemory";
  case 4:
    return "InternalError";
  case 5:
    return "JSLibraryError";
  default:
    return "UnknownCoreError";
  }
}
} 
// ----- StatusError Exception -----
class StatusError : public std::runtime_error {
public:
  StatusError(std::string addonId, std::string localCodeMsg, const std::string& errorMsg)
      : std::runtime_error(errorMsg), addonId_(std::move(addonId)), localCodeMsg_(std::move(localCodeMsg)){}

  StatusError(general_error::GeneralErrorCode localCode, const std::string& errorMsg)
      : std::runtime_error(errorMsg), addonId_(general_error::GeneralAddonId), localCodeMsg_(general_error::toString(localCode)){}

  std::string codeString() const 
  {
    return "[ " + addonId_ + " :: " + localCodeMsg_ + " ]";
  }

  bool isJSError() const 
  {
    return localCodeMsg_ == general_error::toString(general_error::JSLibraryError);
  }

private:
  std::string addonId_;
  std::string localCodeMsg_;
};

} // namespace qvac_errors
