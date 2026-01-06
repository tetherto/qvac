# Depending on the value of SSPLIT_USE_INTERNAL_PRCRE2 this cmake file
# either tries to find the Perl Compatible Regular Expresison library (pcre2)
# on the system (when OFF), or downloads and compiles them locally (when ON).

# The following variables are set:
# PCRE2_FOUND - System has the PCRE library
# PCRE2_LIBRARIES - The PCRE library file
# PCRE2_INCLUDE_DIRS - The folder with the PCRE headers

if(SSPLIT_USE_INTERNAL_PCRE2)
  include(ExternalProject)

  set(PCRE2_VERSION "10.39")
  set(PCRE2_FILENAME "pcre2-${PCRE2_VERSION}")
  set(PCRE2_TARBALL "${PCRE2_FILENAME}.tar.gz")
  set(PCRE2_SRC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/src/3rd-party/${PCRE2_FILENAME})

  # Download tarball only if we don't have the pcre2 source code yet.
  # For the time being, we download and unpack pcre2 into
  # the ssplit source tree. This is not particularly clean
  # but allows us to wipe the build dir without having to
  # re-download pcre2 so often. Git has been instructed to ignore
  # ${PCRE2_SRC_DIR} via .gitignore.
  if (EXISTS ${PCRE2_SRC_DIR}/configure)
    set(PCRE2_URL "")
  else()
      set(PCRE2_URL "https://github.com/PhilipHazel/pcre2/releases/download/${PCRE2_FILENAME}/${PCRE2_TARBALL}")
    message("Downloading pcre2 source code from ${PCRE2_URL}")
  endif()

  # Set configure options for internal pcre2 depeding on compiler
  if(CMAKE_CXX_COMPILER MATCHES "/em\\+\\+(-[a-zA-Z0-9.])?$")
    # jit compilation isn't supported by wasm
    set(PCRE2_JIT_OPTION  "-DPCRE2_SUPPORT_JIT=OFF")
  elseif(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    # jit compilation isn't supported on iOS (__clear_cache is unavailable)
    set(PCRE2_JIT_OPTION  "-DPCRE2_SUPPORT_JIT=OFF")
  else()
    set(PCRE2_JIT_OPTION  "-DPCRE2_SUPPORT_JIT=ON")
  endif()

  # On iOS, do not build tests or the pcre2grep executable (avoids MACOSX_BUNDLE install errors)
  set(PCRE2_IOS_DISABLE_TOOLS_AND_TESTS "")
  if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    list(APPEND PCRE2_IOS_DISABLE_TOOLS_AND_TESTS
      -DPCRE2_BUILD_TESTS=OFF
      -DPCRE2_BUILD_PCRE2GREP=OFF
    )
  endif()

  # CMAKE_CROSSCOMPILING_EMULATOR might contain semicolon (;) separated arguments. Preventing list
  # expansion on the arguments of this variable before adding it to PCRE2_CONFIGURE_OPTIONS
  # by replacing semicolon with $<SEMICOLON> as per:
  # https://cmake.org/cmake/help/git-stage/manual/cmake-generator-expressions.7.html#genex:SEMICOLON
  string(REPLACE ";" "$<SEMICOLON>" CMAKE_CROSSCOMPILING_EMULATOR_WITH_SEMICOLON "${CMAKE_CROSSCOMPILING_EMULATOR}")

  set(PCRE2_CONFIGURE_OPTIONS
    -DBUILD_SHARED_LIBS=OFF
    -DCMAKE_INSTALL_PREFIX=${CMAKE_BINARY_DIR}
    -DCMAKE_BUILD_TYPE=Release
    -DCMAKE_INSTALL_LIBDIR=${CMAKE_INSTALL_LIBDIR}
    ${PCRE2_JIT_OPTION}
    ${PCRE2_IOS_DISABLE_TOOLS_AND_TESTS}
    -DCMAKE_POSITION_INDEPENDENT_CODE:BOOL=true # Added for pybind11
    )

  # For cross-compilation, we must pass the toolchain file which will set up all compiler variables correctly
  # When using vcpkg, VCPKG_CHAINLOAD_TOOLCHAIN_FILE or VCPKG_TARGET_TRIPLET contains the actual platform toolchain (e.g., Android)
  # while CMAKE_TOOLCHAIN_FILE is the vcpkg wrapper. We need to pass the platform toolchain to PCRE2.
  if(DEFINED VCPKG_CHAINLOAD_TOOLCHAIN_FILE AND EXISTS "${VCPKG_CHAINLOAD_TOOLCHAIN_FILE}")
    LIST(APPEND PCRE2_CONFIGURE_OPTIONS
      -DCMAKE_TOOLCHAIN_FILE=${VCPKG_CHAINLOAD_TOOLCHAIN_FILE}
    )
  elseif(CMAKE_TOOLCHAIN_FILE)
    LIST(APPEND PCRE2_CONFIGURE_OPTIONS
      -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
    )
  endif()

  # Pass cross-compiling emulator if set
  if(CMAKE_CROSSCOMPILING_EMULATOR)
    LIST(APPEND PCRE2_CONFIGURE_OPTIONS
      -DCMAKE_CROSSCOMPILING_EMULATOR=${CMAKE_CROSSCOMPILING_EMULATOR_WITH_SEMICOLON}
    )
  endif()


  # set include dirs and libraries for PCRE2
  set(PCRE2_LIBRARIES ${CMAKE_BINARY_DIR}/${CMAKE_INSTALL_LIBDIR}/${CMAKE_STATIC_LIBRARY_PREFIX}pcre2-8${CMAKE_STATIC_LIBRARY_SUFFIX})
  set(PCRE2_INCLUDE_DIRS "${CMAKE_BINARY_DIR}/include")
  set(PCRE2_FOUND TRUE CACHE BOOL "Found PCRE2 libraries" FORCE)
  
  # download, configure, compile
  # Use CMAKE_ARGS instead of CONFIGURE_COMMAND to properly pass toolchain file for cross-compilation
  # Use PATCH_COMMAND to fix PCRE2's CMakeLists.txt ordering issue for CMake 3.28+
  if(DEFINED PCRE2_PATCH_SCRIPT AND EXISTS "${PCRE2_PATCH_SCRIPT}")
    ExternalProject_Add(pcre2
      PREFIX ${CMAKE_BINARY_DIR}/pcre2
      URL ${PCRE2_URL}
      DOWNLOAD_DIR ${PCRE2_SRC_DIR}
      SOURCE_DIR ${PCRE2_SRC_DIR}
      PATCH_COMMAND ${CMAKE_COMMAND} -DCMAKE_CURRENT_SOURCE_DIR=${PCRE2_SRC_DIR} -P ${PCRE2_PATCH_SCRIPT}
      CMAKE_ARGS ${PCRE2_CONFIGURE_OPTIONS}
      BUILD_COMMAND ${CMAKE_COMMAND} --build <BINARY_DIR>
      INSTALL_DIR ${CMAKE_BINARY_DIR}
      BUILD_BYPRODUCTS ${PCRE2_LIBRARIES})
    message(STATUS "PCRE2 ExternalProject configured with patch command and CMAKE_ARGS for cross-compilation")
  else()
    ExternalProject_Add(pcre2
      PREFIX ${CMAKE_BINARY_DIR}/pcre2
      URL ${PCRE2_URL}
      DOWNLOAD_DIR ${PCRE2_SRC_DIR}
      SOURCE_DIR ${PCRE2_SRC_DIR}
      CMAKE_ARGS ${PCRE2_CONFIGURE_OPTIONS}
      BUILD_COMMAND ${CMAKE_COMMAND} --build <BINARY_DIR>
      INSTALL_DIR ${CMAKE_BINARY_DIR}
      BUILD_BYPRODUCTS ${PCRE2_LIBRARIES})
    message(WARNING "PCRE2_PATCH_SCRIPT not defined or doesn't exist, skipping patch")
  endif()

else(SSPLIT_USE_INTERNAL_PCRE2)
  
  find_library(PCRE2_LIBRARIES NAMES pcre2 pcre2-8 pcre2-8-static pcre2-posix-static pcre2-8-staticd pcre2-posix-staticd)
  find_path(PCRE2_INCLUDE_DIRS pcre2.h)

endif(SSPLIT_USE_INTERNAL_PCRE2)

if(PCRE2_LIBRARIES AND PCRE2_INCLUDE_DIRS)
  # message(STATUS "PCRE2 libs: ${PCRE2_LIBRARIES}")
  # message(STATUS "PCRE2 include directory: ${PCRE2_INCLUDE_DIRS}")
  set(PCRE2_FOUND TRUE CACHE BOOL "Found PCRE2 libraries" FORCE)
  # add_custom_target(pcre2)
else()
  set(PCRE2_FOUND FALSE CACHE BOOL "Found PCRE2 libraries" FORCE)
  # message(STATUS "PCRE2 library not found.")
endif()
