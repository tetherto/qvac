include_guard(GLOBAL)

# Call after project(): bare-make's toolchain otherwise overwrites this default.
macro(qvac_use_windows_shared_crt)
  if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
  endif()
endmacro()

# Runtime owners stage redistributable DLLs beside their .bare entry point.
# UCRT comes from Windows; Debug runtimes are never redistributed.
function(qvac_install_windows_runtime destination)
  if(NOT MSVC)
    return()
  endif()
  set(CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS_SKIP TRUE)
  set(CMAKE_INSTALL_DEBUG_LIBRARIES FALSE)
  set(CMAKE_INSTALL_DEBUG_LIBRARIES_ONLY FALSE)
  set(CMAKE_INSTALL_UCRT_LIBRARIES FALSE)
  include(InstallRequiredSystemLibraries)
  if(NOT CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS)
    message(FATAL_ERROR "No redistributable MSVC runtime DLLs found; set MSVC_REDIST_DIR")
  endif()
  install(FILES ${CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS}
    DESTINATION "${destination}" CONFIGURATIONS Release RelWithDebInfo MinSizeRel)
endfunction()
