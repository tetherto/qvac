# CMake script to patch PCRE2 CMakeLists.txt for CMake 3.28+ compatibility
# This script is executed as a PATCH_COMMAND in the ExternalProject

set(PCRE2_CMAKE_FILE "${CMAKE_CURRENT_SOURCE_DIR}/CMakeLists.txt")

if(EXISTS "${PCRE2_CMAKE_FILE}")
  file(READ "${PCRE2_CMAKE_FILE}" CONTENT)

  # Check if already patched
  string(FIND "${CONTENT}" "CMAKE_MINIMUM_REQUIRED(VERSION 3.5" ALREADY_PATCHED)
  string(FIND "${CONTENT}" "PROJECT(PCRE2 C)" HAS_PROJECT)

  if(ALREADY_PATCHED EQUAL -1 AND NOT HAS_PROJECT EQUAL -1)
    message(STATUS "Patching PCRE2 CMakeLists.txt for CMake 3.28+ compatibility")

    # Replace PROJECT before CMAKE_MINIMUM_REQUIRED and update version
    string(REGEX REPLACE
      "PROJECT\\(PCRE2 C\\)\n\n# Increased[^\n]*\n# Increased[^\n]*\nCMAKE_MINIMUM_REQUIRED\\(VERSION 3\\.0\\.0\\)"
      "# Increased minimum to 2.8.5 to support GNUInstallDirs.\n# Increased minimum to 3.0.0 because older than 2.8.12 is deprecated.\nCMAKE_MINIMUM_REQUIRED(VERSION 3.5.0)\n\nPROJECT(PCRE2 C)"
      CONTENT "${CONTENT}")

    file(WRITE "${PCRE2_CMAKE_FILE}" "${CONTENT}")
    message(STATUS "PCRE2 CMakeLists.txt patched successfully")
  else()
    message(STATUS "PCRE2 CMakeLists.txt already patched or unexpected format")
  endif()
else()
  message(WARNING "PCRE2 CMakeLists.txt not found at ${PCRE2_CMAKE_FILE}")
endif()
