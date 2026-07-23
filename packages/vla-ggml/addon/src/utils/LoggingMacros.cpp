#include "LoggingMacros.hpp"

namespace qvac_lib_infer_vla_ggml {
namespace logging {

// Default to ERROR; the JS layer can raise this through its own logger
// configuration after binding.setLogger() is wired up.
std::atomic<qvac_lib_inference_addon_cpp::logger::Priority> g_verbosityLevel{
    qvac_lib_inference_addon_cpp::logger::Priority::ERROR};

} // namespace logging
} // namespace qvac_lib_infer_vla_ggml
