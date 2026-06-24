#pragma once

#include <memory>
#include <string>

#include <onnxruntime_cxx_api.h>

#ifdef _WIN32
#include <windows.h>
#endif

namespace qvac::ttslib {

inline Ort::Env &getOrtEnv() {
  static Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "qvac-tts");
  return env;
}

inline std::unique_ptr<Ort::Session>
createOrtSession(const std::string &modelPath,
                 const Ort::SessionOptions &options) {
#ifdef _WIN32
  int len = MultiByteToWideChar(CP_UTF8, 0, modelPath.c_str(),
                                static_cast<int>(modelPath.size()), nullptr, 0);
  std::wstring wPath(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, modelPath.c_str(),
                      static_cast<int>(modelPath.size()), wPath.data(), len);
  return std::make_unique<Ort::Session>(getOrtEnv(), wPath.c_str(), options);
#else
  return std::make_unique<Ort::Session>(getOrtEnv(), modelPath.c_str(),
                                        options);
#endif
}

} // namespace qvac::ttslib
