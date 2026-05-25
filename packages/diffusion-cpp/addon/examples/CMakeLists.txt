cmake_minimum_required(VERSION 3.25)

project(img2vid-wan-example CXX)

# Find dependencies (same as main build)
find_path(PICOJSON_INCLUDE_DIRS "picojson/picojson.h" REQUIRED)
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/JsInterface.hpp" REQUIRED)
find_path(STB_IMAGE_WRITE_INCLUDE_DIR "stb_image_write.h" REQUIRED)
find_path(STB_IMAGE_INCLUDE_DIR "stb_image.h" REQUIRED)

find_package(stable-diffusion-cpp CONFIG REQUIRED)
find_package(ggml CONFIG REQUIRED)

# Create executable
add_executable(img2vid-wan-example img2vid-wan-example.cpp)

# Link libraries
target_link_libraries(
  img2vid-wan-example
  PRIVATE
    stable-diffusion::stable-diffusion
)

# Include directories
target_include_directories(
  img2vid-wan-example
  PRIVATE
    ${PICOJSON_INCLUDE_DIRS}
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${STB_IMAGE_WRITE_INCLUDE_DIR}
    ${STB_IMAGE_INCLUDE_DIR}
    ${CMAKE_SOURCE_DIR}/addon/src
)

# C++ standard
target_compile_features(img2vid-wan-example PRIVATE cxx_std_20)
target_compile_definitions(img2vid-wan-example PRIVATE JS_LOGGER)
