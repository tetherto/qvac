find_package(GTest CONFIG REQUIRED)

add_executable(
  addon-test
  test_hparams.cpp
  test_backend_selection.cpp
  test_smolvla_mmap_gate.cpp
  test_model_factory.cpp
  test_groot_load.cpp
  test_groot_m4_1_vlfusion.cpp
  test_groot_m4_2_encoders.cpp
  test_groot_m4_3_dit.cpp
  test_groot_m4_4_euler.cpp
  test_groot_m4_5_text.cpp
  test_groot_m4_5_vision.cpp
  test_groot_m4_5_backbone.cpp
  test_groot_m4_6_pipeline.cpp
  test_groot_m4_7_positions.cpp
  test_groot_surface.cpp
  test_groot_infer_parity.cpp
  test_groot_embodiment_resolve.cpp
  test_groot_embodiment_sweep.cpp
  test_pi05_m3_1_siglip.cpp
  test_pi05_m3_2_siglip_block.cpp
  test_pi05_m3_3_siglip_tower.cpp
  test_pi05_m3_4_vlm_embed.cpp
  test_pi05_m3_5_vlm_block.cpp
  test_pi05_m3_6_vlm_prefill.cpp
  test_pi05_m3_7_time_cond.cpp
  test_pi05_m3_8_adarms_split.cpp
  test_pi05_m3_9_expert_block.cpp
  test_pi05_m3_10_expert_full.cpp
  test_pi05_m3_11_euler_step.cpp
  test_pi05_m3_12_ode_loop.cpp
  test_pi05_m3_13_end_to_end.cpp
  test_pi05_integration.cpp
  backend_env.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/smolvla.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/smolvla_adapter.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/pi05.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/groot.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/model_factory.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
)

target_compile_options(
  addon-test
  PRIVATE
    -Wno-deprecated
    -Wfatal-errors
    -g)

target_include_directories(
  addon-test
  PRIVATE
    ${CMAKE_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_compile_features(addon-test PRIVATE cxx_std_20)

# BackendSelection.cpp references BACKENDS_SUBDIR on its DL load path. The addon
# target defines it, but addon-test compiles that TU separately. Tests preload
# backends via backend_env.cpp from GGML_BACKEND_DIR, so the value is unused at
# runtime — a placeholder just lets the TU compile.
target_compile_definitions(addon-test PRIVATE BACKENDS_SUBDIR="qvac-lib-infer-vla")

target_link_libraries(
  addon-test
  PRIVATE
    qvac-fabric::headers
    ${qvac_fabric_target}_module
    GTest::gtest
    GTest::gtest_main
    GTest::gmock_main
)

# GGML_BACKEND_DL/DIR, copy qvac__fabric@0.bare + backends next to the binary,
# rpath, and the win32 delay-load helper. See qvac-addon.cmake for the details.
qvac_addon_stage_fabric_for_test(addon-test ${qvac_fabric_target})

# AddressSanitizer on the test executable, kept in a deliberately LIMITED form.
# addon-test dynamically links the shared @qvac/fabric runtime
# (qvac__fabric@0.bare), and the shipped fabric prebuild is built with
# -static-libstdc++. See packages/classification-ggml/test/unit/CMakeLists.txt
# for the full rationale. scripts/run-cpp-tests.js sets ASAN_OPTIONS for local/CI runs.
if(NOT WIN32)
  target_link_libraries(addon-test PRIVATE -fsanitize=address)
endif()

add_test(NAME VlaGgmlUnit COMMAND addon-test)
set_tests_properties(VlaGgmlUnit PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 900)
