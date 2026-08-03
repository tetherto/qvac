#ifndef QVAC_TTSGGML_BACKENDLOADER_HPP
#define QVAC_TTSGGML_BACKENDLOADER_HPP

#include <string>

namespace qvac::ttsggml::backend {

// Loads this addon's uniquely named dynamic GGML backends once. backendsRoot
// is the package prebuilds directory; BACKENDS_SUBDIR is appended internally.
void ensureLoaded(const std::string& backendsRoot);

} // namespace qvac::ttsggml::backend

#endif // QVAC_TTSGGML_BACKENDLOADER_HPP
