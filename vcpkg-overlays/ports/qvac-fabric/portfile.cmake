vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac-fabric-llm.cpp
  REF 597cb574d94b8dbba1895a9fa90af7d317653eb4
  SHA512 83f20dd167cf5a522f19aab0d9361cc73239076c5205e15751d2acb8919989b8ed78944919d75ff826ee68ca30b96691d63ab99b2007cf5f9687d5bdef5cf878
)

# Upstream CMake options only, passed through to vcpkg_cmake_configure.
vcpkg_check_features(
  OUT_FEATURE_OPTIONS FEATURE_OPTIONS
  FEATURES
    force-profiler FORCE_GGML_VK_PERF_LOGGER
    llama BUILD_LLAMA
    vector-index GGML_VECTOR_INDEX
)

# Portfile-only feature flags (drive PLATFORM_OPTIONS; not upstream cache vars).
vcpkg_check_features(
  OUT_FEATURE_OPTIONS _PORTFILE_FEATURE_OPTIONS
  FEATURES
    gpu-backends BUILD_GPU_BACKENDS
    kleidiai BUILD_KLEIDIAI
    openmp BUILD_OPENMP
    hip-backend BUILD_HIP_BACKEND
    cuda-backend BUILD_CUDA_BACKEND
    cuda-jetson-backend BUILD_CUDA_JETSON_BACKEND
    rpc-server BUILD_RPC_SERVER
    rpc-rdma BUILD_RPC_RDMA
)

# gpu-backends is default-on via default-features in vcpkg.json. CPU-only
# consumers (e.g. @qvac/classification-ggml) disable it with
# default-features:false (and re-add 'llama' if needed).
if(NOT BUILD_GPU_BACKENDS)
  message(STATUS "qvac-fabric: gpu-backends feature OFF, building CPU-only ggml (no Metal/Vulkan/CUDA/OpenCL)")
endif()

set(PLATFORM_OPTIONS)

if (VCPKG_TARGET_IS_ANDROID AND BUILD_GPU_BACKENDS)
  # The Android NDK ships only the C Vulkan headers; the ggml Vulkan backend
  # additionally needs the C++ bindings (vulkan.hpp) and SPIRV-Headers, which as
  # of b9840 ggml fetches itself via FetchContent (ggml/src/ggml-vulkan/CMakeLists.txt,
  # `if (ANDROID)` block). The registry vcpkg-cmake sets FETCHCONTENT_FULLY_DISCONNECTED=ON
  # globally, so allow the fetch here (same as the kleidiai path below).
  list(APPEND PLATFORM_OPTIONS -DFETCHCONTENT_FULLY_DISCONNECTED=OFF)
endif()

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
# Desktop Linux and Windows also need GGML_BACKEND_DL=ON so that GPU backends
# and CPU variants are runtime-loaded modules. This keeps optional backend DLL
# dependencies out of the core Windows module and lets CPU variant scoring pick
# the best instruction set at runtime.
if(VCPKG_TARGET_IS_ANDROID OR ((VCPKG_TARGET_IS_LINUX OR VCPKG_TARGET_IS_WINDOWS) AND BUILD_GPU_BACKENDS))
  # Without DL, the desktop build links a single static GPU backend and a
  # second backend cannot be stacked.
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

# HIP/ROCm backend is opt-in via the 'hip-backend' feature (Linux + AMD only).
# Only @qvac/vla-ggml requests it, so every other consumer builds with no HIP
# and gains no ROCm dependency. Builds libqvac-ggml-hip.so as a standalone DL
# module alongside Vulkan (GGML_BACKEND_DL is already ON above), so the addon
# dlopen's whichever GPU backend BackendSelection picks at runtime. The `hip`
# feature-dependency port forwards the system ROCm's find_package() configs.
#
# FAIL-SAFE: enable GGML_HIP only when a ROCm SDK is actually present. On a build
# host without ROCm we skip HIP and build Vulkan/CPU only. The build never
# hard-fails, and at runtime a missing HIP module just isn't loaded (the DL
# loader skips it) so BackendSelection falls back to Vulkan/CPU. Targets gfx1151
# (Strix Halo / Radeon 8060S); the HIP compiler + ROCM_PATH come from the build env.
# linux-x64 only: AMD GPU hosts (Strix Halo / gfx1151) are x86_64, and the ROCm
# dist is x64. On other arches (e.g. linux-arm64) HIP is skipped even if the
# feature is requested, with no ROCm requirement or build break.
if(VCPKG_TARGET_IS_LINUX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "x64" AND BUILD_GPU_BACKENDS AND BUILD_HIP_BACKEND)
  # DETERMINISTIC: requesting hip-backend REQUIRES a ROCm SDK at build time. We
  # must NOT silently skip when ROCm is absent. A host-dependent skip yields a
  # no-HIP package with the SAME vcpkg ABI as a real HIP build, which the binary
  # cache then conflates (cache poisoning: a no-ROCm build caches a no-HIP
  # package that ROCm-equipped builds then restore). So ROCm present => HIP;
  # ROCm absent => hard error (don't request hip-backend on a host without ROCm).
  # The RUNTIME fail-safe is unchanged: an absent HIP module / non-AMD target is
  # simply not loaded and BackendSelection falls back to Vulkan/CPU.
  if(NOT (DEFINED ENV{ROCM_PATH} AND EXISTS "$ENV{ROCM_PATH}/lib/cmake/hip/hip-config.cmake"))
    message(FATAL_ERROR "qvac-fabric: hip-backend feature requires a ROCm SDK. Set ROCM_PATH to a ROCm/TheRock install containing lib/cmake/hip/hip-config.cmake. Do not request hip-backend on a host without ROCm.")
  endif()
  message(STATUS "qvac-fabric: hip-backend ON, building GGML_HIP (gfx1151)")
  list(APPEND PLATFORM_OPTIONS
    -DGGML_HIP=ON
    -DAMDGPU_TARGETS=gfx1151
    -DCMAKE_HIP_ARCHITECTURES=gfx1151)
endif()

# CUDA backend, opt-in via 'cuda-backend': a runtime-loaded module beside Vulkan.
# vcpkg.json limits it to Linux x64/arm64 and Windows x64 and pulls in
# gpu-backends; 'cuda-jetson-backend' builds the CUDA 12.6 Jetson Orin variant.
# Requesting it without nvcc is an error, never a silent skip: a no-CUDA package
# would share the real CUDA build's binary-cache ABI.
if(BUILD_CUDA_BACKEND)
  # vcpkg does not hash the host nvcc, so the expected version lives here and a
  # new pin changes the port hash. x64 and arm64 ship ggml's default CUDA 13
  # list plus 80-real; Jetson Orin needs only its own arch. The semicolons stay
  # escaped so vcpkg passes one argument.
  if(BUILD_CUDA_JETSON_BACKEND)
    set(QVAC_CUDA_NVCC_VERSION "12.6.85")
    set(QVAC_CUDA_ARCHS "87-real")
    # Ships beside the CUDA 13 module, so it needs its own file name.
    set(QVAC_CUDA_MODULE_SUFFIX "-jetson")
  else()
    set(QVAC_CUDA_NVCC_VERSION "13.0.88")
    set(QVAC_CUDA_ARCHS "75-virtual\;80-virtual\;80-real\;86-real\;89-real\;90-virtual\;120a-real\;121a-real")
    set(QVAC_CUDA_MODULE_SUFFIX "")
  endif()
  # A provisioned toolkit (CUDACXX, then CUDA_PATH) wins over PATH and
  # /usr/local/cuda. On Windows vcpkg resets PATH unless VCPKG_KEEP_ENV_VARS
  # keeps it.
  if(NOT "$ENV{CUDACXX}" STREQUAL "")
    set(NVCC_EXECUTABLE "$ENV{CUDACXX}")
  else()
    find_program(NVCC_EXECUTABLE nvcc HINTS ENV CUDA_PATH PATHS /usr/local/cuda PATH_SUFFIXES bin REQUIRED)
  endif()
  execute_process(
    COMMAND "${NVCC_EXECUTABLE}" --version
    OUTPUT_VARIABLE QVAC_NVCC_VERSION_OUT
    COMMAND_ERROR_IS_FATAL ANY)
  string(REGEX MATCH "V([0-9]+\\.[0-9]+\\.[0-9]+)" _ "${QVAC_NVCC_VERSION_OUT}")
  set(QVAC_NVCC_VERSION "${CMAKE_MATCH_1}")
  # setup-cuda sets QVAC_CUDA_TOOLKIT and the qvac triplets hash it into the
  # ABI, so with it set only the pinned toolkit may build.
  if(NOT QVAC_NVCC_VERSION VERSION_EQUAL QVAC_CUDA_NVCC_VERSION)
    if(NOT "$ENV{QVAC_CUDA_TOOLKIT}" STREQUAL "")
      message(FATAL_ERROR "qvac-fabric: ${NVCC_EXECUTABLE} is CUDA ${QVAC_NVCC_VERSION}, port expects ${QVAC_CUDA_NVCC_VERSION}")
    endif()
    message(WARNING "qvac-fabric: building with unpinned CUDA ${QVAC_NVCC_VERSION}, port expects ${QVAC_CUDA_NVCC_VERSION}. Not for release builds.")
  endif()
  message(STATUS "qvac-fabric: cuda-backend ON, nvcc ${NVCC_EXECUTABLE} (V${QVAC_NVCC_VERSION}), arch ${QVAC_CUDA_ARCHS}")

  list(APPEND PLATFORM_OPTIONS
    -DGGML_CUDA=ON
    "-DCMAKE_CUDA_ARCHITECTURES=${QVAC_CUDA_ARCHS}"
    "-DCMAKE_CUDA_COMPILER=${NVCC_EXECUTABLE}")
  if(QVAC_CUDA_MODULE_SUFFIX)
    list(APPEND PLATFORM_OPTIONS "-DGGML_CUDA_MODULE_SUFFIX=${QVAC_CUDA_MODULE_SUFFIX}")
  endif()
  if(VCPKG_TARGET_IS_LINUX)
    list(APPEND PLATFORM_OPTIONS
    # nvcc defaults to g++ as host compiler, which rejects the clang-only
    # -stdlib=libc++ link flag the triplet sets.
    -DCMAKE_CUDA_HOST_COMPILER=clang++
    # Neither pinned toolkit accepts clang 22 yet.
    "-DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler")
  endif()
endif()

if(VCPKG_TARGET_IS_ANDROID AND BUILD_KLEIDIAI)
  message(STATUS "qvac-fabric: kleidiai feature ON, building with ARM KleidiAI optimized kernels")
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
# without libc++ installed, such as stock ubuntu-24.04. No CPU backend registers,
# inference aborts). Statically link the C++ runtime into the modules so they
# are self-contained, matching how the addons link themselves. The module<->addon
# boundary is the C ggml-backend ABI, so per-module libc++ copies never exchange
# C++ objects. Linux only: Apple/iOS use Metal frameworks, Android ships
# libc++_shared via the NDK STL, Windows uses the MSVC runtime.
if(VCPKG_TARGET_IS_LINUX AND DL_BACKENDS)
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

set(BUILD_RPC_SERVER_TOOL OFF)
if(BUILD_RPC_SERVER)
  if(NOT BUILD_LLAMA)
    message(FATAL_ERROR "qvac-fabric: rpc-server feature requires the llama feature so the tools tree can be configured")
  else()
    set(BUILD_RPC_SERVER_TOOL ON)
  endif()
endif()

set(BUILD_RPC_RDMA_TRANSPORT OFF)
if(BUILD_RPC_RDMA)
  if(NOT VCPKG_TARGET_IS_LINUX)
    message(FATAL_ERROR "qvac-fabric: rpc-rdma feature is supported only on Linux because qvac-fabric RDMA uses libibverbs.")
  endif()

  message(STATUS "qvac-fabric: rpc-rdma feature ON - requiring system libibverbs")
  set(BUILD_RPC_RDMA_TRANSPORT ON)
else()
  message(STATUS "qvac-fabric: rpc-rdma feature OFF - building RPC over TCP only")
endif()

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    -DGGML_NATIVE=OFF
    -DGGML_CCACHE=OFF
    -DGGML_LLAMAFILE=OFF
    -DGGML_RPC=ON
    -DGGML_RPC_RDMA=${BUILD_RPC_RDMA_TRANSPORT}
    -DLLAMA_CURL=OFF
    -DLLAMA_OPENSSL=OFF
    -DLLAMA_BUILD_TESTS=OFF
    -DLLAMA_BUILD_TOOLS=${BUILD_RPC_SERVER_TOOL}
    -DLLAMA_TOOLS_INSTALL=${BUILD_RPC_SERVER_TOOL}
    -DLLAMA_BUILD_EXAMPLES=OFF
    -DLLAMA_BUILD_SERVER=OFF
    -DLLAMA_BUILD_APP=OFF
    -DMTMD_VIDEO=OFF
    -DLLAMA_ALL_WARNINGS=OFF
    ${LLAMA_OPTIONS}
    ${PLATFORM_OPTIONS}
    ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()
vcpkg_cmake_config_fixup(
  PACKAGE_NAME ggml)

if(BUILD_CUDA_BACKEND)
  set(QVAC_CUDA_MODULE "${CURRENT_PACKAGES_DIR}/lib/${VCPKG_TARGET_SHARED_LIBRARY_PREFIX}qvac-ggml-cuda${QVAC_CUDA_MODULE_SUFFIX}${VCPKG_TARGET_SHARED_LIBRARY_SUFFIX}")
  if(NOT EXISTS "${QVAC_CUDA_MODULE}")
    message(FATAL_ERROR "qvac-fabric: expected CUDA module was not installed at ${QVAC_CUDA_MODULE}")
  endif()
endif()

if(BUILD_LLAMA)
  vcpkg_cmake_config_fixup(PACKAGE_NAME llama)
endif()

if(BUILD_RPC_SERVER_TOOL)
  vcpkg_copy_tools(TOOL_NAMES ggml-rpc-server AUTO_CLEAN)
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
