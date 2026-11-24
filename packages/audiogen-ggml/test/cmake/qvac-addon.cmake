function(qvac_addon_preproject)
endfunction()

function(qvac_addon_project_setup)
endfunction()

function(qvac_addon_fuzz_only_return)
endfunction()

macro(qvac_addon_use_fabric)
  add_library(qvac-fabric::headers INTERFACE IMPORTED)
  add_library(fabric_module INTERFACE IMPORTED)
  set(qvac_fabric_target fabric)
endmacro()

function(qvac_addon_speech_engines)
  add_library(ggml ALIAS qvac-fabric::headers)
  add_library(audiogen-cpp::audiogen-cpp INTERFACE IMPORTED)
endfunction()

function(bare_target output)
  set(${output} linux-x64 PARENT_SCOPE)
endfunction()

function(add_bare_module name)
  add_library(${name}_module MODULE)
  set(${name} ${name}_module PARENT_SCOPE)
endfunction()

function(qvac_addon_link_fabric)
endfunction()

function(qvac_addon_finalize)
endfunction()

function(qvac_addon_stage_fabric_for_test target fabric)
  if(NOT TARGET ${fabric}_module)
    message(FATAL_ERROR "Missing Fabric runtime")
  endif()
  set_property(TARGET ${target} PROPERTY TEST_FABRIC_STAGED TRUE)
endfunction()

function(qvac_addon_add_fuzz_subdirectory)
  if(BUILD_TESTING)
    get_target_property(staged audiogen_ggml_tests TEST_FABRIC_STAGED)
    if(NOT staged)
      message(FATAL_ERROR "AudioGen tests must stage the Fabric runtime")
    endif()
    get_target_property(libraries audiogen_ggml_tests LINK_LIBRARIES)
    if(NOT "qvac-fabric::headers" IN_LIST libraries OR NOT "fabric_module" IN_LIST libraries)
      message(FATAL_ERROR "AudioGen tests must link the Fabric headers and runtime")
    endif()
  endif()
endfunction()
