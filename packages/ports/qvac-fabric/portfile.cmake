vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac-fabric-llm.cpp
  REF v${VERSION}
  SHA512 e016077df98ca4dd84ad8151d6e0289930e2819d403bab16e69b14272521fbc08ebeb7a54e6343554c8b8283641365a146c0d7dc2ba7ca55ee65a5106cf1cddd
)

# Upstream CMake options only — passed through to vcpkg_cmake_configure.
vcpkg_check_features(
  OUT_FEATURE_OPTIONS FEATURE_OPTIONS
  FEATURES
    force-profiler FORCE_GGML_VK_PERF_LOGGER
    llama BUILD_LLAMA
)

# Portfile-only feature flags (drive PLATFORM_OPTIONS; not upstream cache vars).
vcpkg_check_features(
  OUT_FEATURE_OPTIONS _PORTFILE_FEATURE_OPTIONS
  FEATURES
    gpu-backends BUILD_GPU_BACKENDS
    kleidiai BUILD_KLEIDIAI
    openmp BUILD_OPENMP
    hip-backend BUILD_HIP_BACKEND
)

# gpu-backends is default-on via default-features in vcpkg.json. CPU-only
# consumers (e.g. @qvac/classification-ggml) disable it with
# default-features:false (and re-add 'llama' if needed).
if(NOT BUILD_GPU_BACKENDS)
  message(STATUS "qvac-fabric: gpu-backends feature OFF — building CPU-only ggml (no Metal/Vulkan/CUDA/OpenCL)")
endif()

if (VCPKG_TARGET_IS_ANDROID AND BUILD_GPU_BACKENDS)
  # NDK only comes with C headers.
  # Make sure C++ header exists, it will be used by ggml tensor library.
  # Need to determine installed vulkan version and download correct headers
  include(${CMAKE_CURRENT_LIST_DIR}/android-vulkan-version.cmake)
  detect_ndk_vulkan_version()
  message(STATUS "Using Vulkan C++ wrappers from version: ${vulkan_version}")
  file(DOWNLOAD
    "https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v${vulkan_version}.tar.gz"
    "${SOURCE_PATH}/vulkan-sdk-${vulkan_version}.tar.gz"
    TLS_VERIFY ON
  )

  file(ARCHIVE_EXTRACT
    INPUT "${SOURCE_PATH}/vulkan-sdk-${vulkan_version}.tar.gz"
    DESTINATION "${SOURCE_PATH}"
    PATTERNS "*.hpp"
  )

  file(RENAME
    "${SOURCE_PATH}/Vulkan-Headers-${vulkan_version}"
    "${SOURCE_PATH}/ggml/src/ggml-vulkan/vulkan_cpp_wrapper"
  )
endif()

set(PLATFORM_OPTIONS)

if(NOT BUILD_GPU_BACKENDS)
  # Force every GPU backend off explicitly, in case upstream defaults change.
  list(APPEND PLATFORM_OPTIONS
    -DGGML_METAL=OFF
    -DGGML_VULKAN=OFF
    -DGGML_CUDA=OFF
    -DGGML_OPENCL=OFF
  )
  if (VCPKG_TARGET_IS_IOS)
    # Same iOS BLAS/Accelerate gating as the GPU-on path; unrelated to the
    # CPU-vs-GPU split, an iOS-toolchain workaround for missing frameworks.
    list(APPEND PLATFORM_OPTIONS -DGGML_BLAS=OFF -DGGML_ACCELERATE=OFF)
  endif()
elseif (VCPKG_TARGET_IS_OSX OR VCPKG_TARGET_IS_IOS)
  list(APPEND PLATFORM_OPTIONS -DGGML_METAL=ON)
  if (VCPKG_TARGET_IS_IOS)
    list(APPEND PLATFORM_OPTIONS -DGGML_BLAS=OFF -DGGML_ACCELERATE=OFF)
  endif()
else()
  list(APPEND PLATFORM_OPTIONS -DGGML_VULKAN=ON)
endif()

# Android: always build CPU variants (NEON_DOTPROD, NEON_I8MM, etc.) and CPU
# repacking. These are CPU-only runtime optimizations selected based on the
# device's SIMD capabilities at load time, completely orthogonal to the GPU
# backends. Bundling them is essential for good CPU inference performance on
# the wide range of arm64 devices the addons ship to. Requires GGML_BACKEND_DL
# to dispatch the variants at runtime; the existing #ifdef guard around
# `ggml_backend_load_all_from_path()` in ggml-backend-reg.cpp keeps the search
# scoped to the consumer's own prebuilds dir.
if(VCPKG_TARGET_IS_ANDROID OR (VCPKG_TARGET_IS_LINUX AND BUILD_GPU_BACKENDS))
  # Desktop Linux also needs GGML_BACKEND_DL=ON so that multiple GPU backends
  # (Vulkan + HIP/ROCm) can coexist as separately-loaded modules, the same way
  # Android dispatches CPU variants at runtime. Without DL the Linux build links
  # a single static GPU backend and a second one (HIP) cannot be stacked.
  # GGML_NATIVE is incompatible with DL, so CPU variants are dispatched via
  # GGML_CPU_ALL_VARIANTS instead. Consumers must ship the core ggml/llama libs
  # alongside their backend modules so the dynamically-linked .bare can resolve
  # them at load time.
  set(DL_BACKENDS ON)
  list(APPEND PLATFORM_OPTIONS
    -DGGML_BACKEND_DL=ON
    -DGGML_CPU_ALL_VARIANTS=ON
    -DGGML_CPU_REPACK=ON)
else()
  set(DL_BACKENDS OFF)
endif()

# HIP/ROCm backend — opt-in via the 'hip-backend' feature (Linux + AMD only).
# Only @qvac/vla-ggml requests it, so every other consumer builds with no HIP
# and gains no ROCm dependency. Builds libqvac-ggml-hip.so as a standalone DL
# module alongside Vulkan (GGML_BACKEND_DL is already ON above), so the addon
# dlopen's whichever GPU backend BackendSelection picks at runtime. The `hip`
# feature-dependency port forwards the system ROCm's find_package() configs.
#
# FAIL-SAFE: enable GGML_HIP only when a ROCm SDK is actually present. On a build
# host without ROCm we skip HIP and build Vulkan/CPU only — the build never
# hard-fails, and at runtime a missing HIP module just isn't loaded (the DL
# loader skips it) so BackendSelection falls back to Vulkan/CPU. Targets gfx1151
# (Strix Halo / Radeon 8060S); the HIP compiler + ROCM_PATH come from the build env.
# linux-x64 only: AMD GPU hosts (Strix Halo / gfx1151) are x86_64, and the ROCm
# dist is x64. On other arches (e.g. linux-arm64) HIP is skipped even if the
# feature is requested — no ROCm requirement, no build break.
if(VCPKG_TARGET_IS_LINUX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "x64" AND BUILD_GPU_BACKENDS AND BUILD_HIP_BACKEND)
  # DETERMINISTIC: requesting hip-backend REQUIRES a ROCm SDK at build time. We
  # must NOT silently skip when ROCm is absent — a host-dependent skip yields a
  # no-HIP package with the SAME vcpkg ABI as a real HIP build, which the binary
  # cache then conflates (cache poisoning: a no-ROCm build caches a no-HIP
  # package that ROCm-equipped builds then restore). So ROCm present => HIP;
  # ROCm absent => hard error (don't request hip-backend on a host without ROCm).
  # The RUNTIME fail-safe is unchanged: an absent HIP module / non-AMD target is
  # simply not loaded and BackendSelection falls back to Vulkan/CPU.
  if(NOT (DEFINED ENV{ROCM_PATH} AND EXISTS "$ENV{ROCM_PATH}/lib/cmake/hip/hip-config.cmake"))
    message(FATAL_ERROR "qvac-fabric: hip-backend feature requires a ROCm SDK — set ROCM_PATH to a ROCm/TheRock install containing lib/cmake/hip/hip-config.cmake. Do not request hip-backend on a host without ROCm.")
  endif()
  message(STATUS "qvac-fabric: hip-backend ON — building GGML_HIP (gfx1151)")
  list(APPEND PLATFORM_OPTIONS
    -DGGML_HIP=ON
    -DAMDGPU_TARGETS=gfx1151
    -DCMAKE_HIP_ARCHITECTURES=gfx1151)
endif()

if(VCPKG_TARGET_IS_ANDROID AND BUILD_KLEIDIAI)
  message(STATUS "qvac-fabric: kleidiai feature ON — building with ARM KleidiAI optimized kernels")
  # ggml only vendors KleidiAI via FetchContent; registry vcpkg-cmake sets
  # FETCHCONTENT_FULLY_DISCONNECTED=ON globally, so allow the download here.
  list(APPEND PLATFORM_OPTIONS
    -DGGML_CPU_KLEIDIAI=ON
    -DFETCHCONTENT_FULLY_DISCONNECTED=OFF
  )
endif()

if(VCPKG_TARGET_IS_ANDROID AND BUILD_OPENMP)
  message(STATUS "qvac-fabric: OpenMP for Android enabled")
  list(APPEND PLATFORM_OPTIONS -DGGML_OPENMP=ON)
else()
  message(STATUS "qvac-fabric: OpenMP Disabled")
  list(APPEND PLATFORM_OPTIONS -DGGML_OPENMP=OFF)
endif()

if (VCPKG_TARGET_IS_ANDROID AND BUILD_GPU_BACKENDS)
  list(APPEND PLATFORM_OPTIONS -DGGML_OPENCL=ON)
endif()

if(BUILD_GPU_BACKENDS AND NOT VCPKG_TARGET_IS_OSX AND NOT VCPKG_TARGET_IS_IOS)
  if(VCPKG_TARGET_IS_WINDOWS AND NOT VCPKG_TARGET_IS_MINGW)
    string(APPEND VCPKG_C_FLAGS " /I${CURRENT_INSTALLED_DIR}/include")
    string(APPEND VCPKG_CXX_FLAGS " /I${CURRENT_INSTALLED_DIR}/include")
  else()
    string(APPEND VCPKG_C_FLAGS " -isystem ${CURRENT_INSTALLED_DIR}/include")
    string(APPEND VCPKG_CXX_FLAGS " -isystem ${CURRENT_INSTALLED_DIR}/include")
  endif()
endif()

# Under GGML_BACKEND_DL the per-microarch backends ship as standalone
# libqvac-ggml-*.so modules that the consumer dlopen's at runtime. Built with
# -stdlib=libc++ they otherwise carry a runtime NEEDED dependency on the system
# libc++.so.1 / libc++abi.so.1, so they silently fail to dlopen on any target
# without libc++ installed (e.g. stock ubuntu-24.04 — no CPU backend registers,
# inference aborts). Statically link the C++ runtime into the modules so they
# are self-contained, matching how the addons link themselves. The module<->addon
# boundary is the C ggml-backend ABI, so per-module libc++ copies never exchange
# C++ objects. Linux only: Apple/iOS use Metal frameworks, Android ships
# libc++_shared via the NDK STL, Windows uses the MSVC runtime.
if(VCPKG_TARGET_IS_LINUX)
  string(APPEND VCPKG_LINKER_FLAGS " -static-libstdc++")
endif()

set(LLAMA_OPTIONS)
if("llama" IN_LIST FEATURES)
  list(APPEND LLAMA_OPTIONS -DLLAMA_MTMD=ON)
else()
  list(APPEND LLAMA_OPTIONS
    -DLLAMA_MTMD=OFF
    -DLLAMA_BUILD_COMMON=OFF
  )
endif()

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    -DGGML_NATIVE=OFF
    -DGGML_CCACHE=OFF
    -DGGML_LLAMAFILE=OFF
    -DLLAMA_CURL=OFF
    -DLLAMA_BUILD_TESTS=OFF
    -DLLAMA_BUILD_TOOLS=OFF
    -DLLAMA_BUILD_EXAMPLES=OFF
    -DLLAMA_BUILD_SERVER=OFF
    -DLLAMA_ALL_WARNINGS=OFF
    ${LLAMA_OPTIONS}
    ${PLATFORM_OPTIONS}
    ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()
vcpkg_cmake_config_fixup(
  PACKAGE_NAME ggml)

if(BUILD_LLAMA)
  vcpkg_cmake_config_fixup(PACKAGE_NAME llama)
endif()

vcpkg_copy_pdbs()
vcpkg_fixup_pkgconfig()


if(BUILD_LLAMA)
  file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/tools/${PORT}")
  file(RENAME "${CURRENT_PACKAGES_DIR}/bin/convert_hf_to_gguf.py" "${CURRENT_PACKAGES_DIR}/tools/${PORT}/convert-hf-to-gguf.py")
  file(INSTALL "${SOURCE_PATH}/gguf-py" DESTINATION "${CURRENT_PACKAGES_DIR}/tools/${PORT}")
  file(RENAME "${CURRENT_PACKAGES_DIR}/bin/vulkan_profiling_analyzer.py" "${CURRENT_PACKAGES_DIR}/tools/${PORT}/vulkan_profiling_analyzer.py")
endif()

if (NOT VCPKG_BUILD_TYPE)
  file(REMOVE "${CURRENT_PACKAGES_DIR}/debug/bin/convert_hf_to_gguf.py")
endif()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
