# Keep the shared compiler, static CRT, and release-only configuration. This
# overlay applies only to diffusion-cpp; other addons retain their own cache.
include("${CMAKE_CURRENT_LIST_DIR}/../../../../vcpkg-overlays/triplets/x64-windows.cmake")

# These ports contain the engine and embedded Vulkan shader payloads. Giving
# their functions/data individual sections permits dead stripping and folding;
# ThinLTO lets lld see through the static-library boundaries at the final link.
# The shared Windows toolchain selects clang-cl, llvm-lib, and lld-link.
if(PORT STREQUAL "ggml" OR PORT STREQUAL "stable-diffusion-cpp")
  string(APPEND VCPKG_C_FLAGS " /Gy /Gw -flto=thin")
  string(APPEND VCPKG_CXX_FLAGS " /Gy /Gw -flto=thin")
endif()
