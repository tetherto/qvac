#include "qvac-fabric.h"

// QVAC_FABRIC_PORT_VERSION is the port the build read from what vcpkg
// installed (CMakeLists.txt), the same value the CMake config records.
extern "C" const char* qvac_fabric_port_version(void) {
  return QVAC_FABRIC_PORT_VERSION;
}
