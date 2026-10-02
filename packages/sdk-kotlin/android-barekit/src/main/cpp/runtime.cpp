#include <string>

extern "C" const char* qvac_kotlin_runtime_anchor() {
  static const std::string runtime = "qvac";
  return runtime.c_str();
}
