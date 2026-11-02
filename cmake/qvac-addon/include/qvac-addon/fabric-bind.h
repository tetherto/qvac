#pragma once

// Binds every fabric import of the calling addon. Call it from the addon's
// exports function: Windows delay-loads the fabric runtime, and Bare resolves
// it only on a thread that is loading an addon, so a first fabric call on a
// worker thread would otherwise fail. Other platforms load fabric with the
// addon, and the call does nothing there.
//
// QVAC_FABRIC_MODULE_NAME is set by qvac_addon_link_fabric().

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
// delayimp.h uses the Windows types, so it comes after windows.h.
#include <delayimp.h>
#endif

inline bool qvacAddonBindFabric() {
#ifdef _WIN32
  return SUCCEEDED(__HrLoadAllImportsForDll(QVAC_FABRIC_MODULE_NAME));
#else
  return true;
#endif
}
