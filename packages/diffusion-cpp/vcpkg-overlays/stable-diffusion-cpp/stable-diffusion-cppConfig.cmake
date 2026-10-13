include(CMakeFindDependencyMacro)
find_dependency(ggml CONFIG)

get_filename_component(_SD_CPP_PREFIX "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)

find_library(STABLE_DIFFUSION_LIBRARY
    NAMES stable-diffusion
    PATHS "${_SD_CPP_PREFIX}/lib"
    NO_DEFAULT_PATH
    REQUIRED
)

find_path(STABLE_DIFFUSION_INCLUDE_DIR
    NAMES stable-diffusion.h
    PATHS "${_SD_CPP_PREFIX}/include"
    NO_DEFAULT_PATH
    REQUIRED
)

if(NOT TARGET stable-diffusion::stable-diffusion)
    add_library(stable-diffusion::stable-diffusion STATIC IMPORTED)
    set_target_properties(stable-diffusion::stable-diffusion PROPERTIES
        IMPORTED_LOCATION             "${STABLE_DIFFUSION_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${STABLE_DIFFUSION_INCLUDE_DIR}"
        INTERFACE_LINK_LIBRARIES      "ggml::ggml"
    )
endif()

unset(_SD_CPP_PREFIX)
