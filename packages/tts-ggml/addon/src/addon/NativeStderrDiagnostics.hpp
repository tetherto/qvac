#pragma once

#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <string>

#ifndef _WIN32
#include <fcntl.h>
#include <unistd.h>
#endif

#include <ggml-backend.h>

namespace qvac::ttsggml {

inline void captureNativeStderr(const char *path) {
#ifndef _WIN32
  if (path == nullptr || *path == '\0')
    return;
  const int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0)
    throw std::runtime_error("Cannot open native stderr diagnostics");
  std::fflush(stderr);
  const int result = dup2(fd, STDERR_FILENO);
  if (fd != STDERR_FILENO)
    close(fd);
  if (result < 0)
    throw std::runtime_error("Cannot redirect native stderr diagnostics");
  std::setvbuf(stderr, nullptr, _IONBF, 0);
#else
  (void)path;
#endif
}

inline void recordNativeBackend(const std::string &backend) {
  const char *path = std::getenv("QVAC_TTS_NATIVE_STDERR_PATH");
  if (path == nullptr || *path == '\0')
    return;
  std::fprintf(stderr, "[native-backend] selected=%s\n", backend.c_str());
  for (std::size_t i = 0; i < ggml_backend_dev_count(); ++i) {
    const auto device = ggml_backend_dev_get(i);
    if (backend == ggml_backend_dev_name(device)) {
      std::fprintf(stderr, "[native-backend] selected=%s description=%s\n",
                   backend.c_str(), ggml_backend_dev_description(device));
    }
  }
}

} // namespace qvac::ttsggml
