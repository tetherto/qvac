#pragma once
namespace qvac_lib_inference_addon_cpp::logger {
enum class Priority { INFO, WARNING };
}
#define QLOG_IF(priority, message)                                             \
  do {                                                                         \
    (void)(priority);                                                          \
    (void)(message);                                                           \
  } while (false)
