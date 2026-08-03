#ifndef QVAC_ASRGGML_BACKENDLOADER_HPP
#define QVAC_ASRGGML_BACKENDLOADER_HPP

#include <string>

namespace qvac::asrggml::backend {

// Loads this addon's uniquely named dynamic GGML backends once. backendsRoot
// is the package prebuilds directory; BACKENDS_SUBDIR is appended internally.
void ensureLoaded(const std::string& backendsRoot);

} // namespace qvac::asrggml::backend

#endif // QVAC_ASRGGML_BACKENDLOADER_HPP
