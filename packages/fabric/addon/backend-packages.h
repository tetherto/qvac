#pragma once

// Internal packaging interface, shared by the runtime and backend carriers.
// The address belongs to the carrier, so dladdr finds its actual location in
// installed, bundled and bare-link layouts without assuming node_modules paths.
#include "qvac-fabric.h"

// NOLINTNEXTLINE(readability-identifier-naming)
extern "C" QVAC_FABRIC_API void qvac_fabric_register_backend_package(
    const void* address, const char* moduleName, const char* backendFile);
