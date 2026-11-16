"""Apply reviewed diagnostic-only hooks to the pinned native engine checkout."""
from pathlib import Path
import argparse
import shutil


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f'Pinned native source changed: {old[:90]!r}')
    return text.replace(old, new, 1)


def instrument(root):
    root = Path(root)
    edits = {}
    p = root / 'CMakeLists.txt'
    edits[p] = replace_once(p.read_text(), 'project("stable-diffusion")', '''project("stable-diffusion")
option(SD_ABOT_DIAGNOSTICS "Compile opt-in ABot diagnostic hooks" OFF)
if(SD_ABOT_DIAGNOSTICS)
    add_compile_definitions(SD_ABOT_DIAGNOSTICS)
endif()''')
    edits[p] = replace_once(edits[p], '    add_definitions(-DGGML_MAX_NAME=160)', '''    if(SD_ABOT_DIAGNOSTICS)
        set(GGML_MAX_NAME 128 CACHE STRING "Match the original registry artifact ABI" FORCE)
        add_definitions(-DGGML_MAX_NAME=128)
    else()
        add_definitions(-DGGML_MAX_NAME=160)
    endif()''')
    p = root / 'src/abot_world.hpp'
    s = replace_once(p.read_text(), '#include "core/ggml_extend.hpp"', '#include "core/abot_diagnostics.h"\n#include "core/ggml_extend.hpp"')
    s = replace_once(s, '        // Flush a deferred KV append', '        abot_diag_dump("initial-noise", block, -1, xt.data(), xt.size());\n\n        // Flush a deferred KV append')
    s = replace_once(s, '            const int H = static_cast<int>(runner->lat_h), W = static_cast<int>(runner->lat_w);', '            abot_diag_dump("flow", block, static_cast<int>(s), flow.data(), flow.numel());\n            const int H = static_cast<int>(runner->lat_h), W = static_cast<int>(runner->lat_w);')
    s = replace_once(s, '                for (size_t i = 0; i < xt.size(); i++) {', '                abot_diag_dump("renoise", block, static_cast<int>(s), eps.data(), eps.size());\n                for (size_t i = 0; i < xt.size(); i++) {')
    s = replace_once(s, '        out_frames.clear();', '        abot_diag_dump("final-latents", block, -1, xt.data(), xt.size());\n        out_frames.clear();')
    s = replace_once(s, '        sd_tiling_params_t no_tiling = {};', '        abot_diag_dump("decoder-input", total / Fb - 1, -1, z.data(), z.numel());\n        sd_tiling_params_t no_tiling = {};')
    s = replace_once(s, '        // px {W_px, H_px, T_px, 3}:', '        abot_diag_dump("decoder-output", total / Fb - 1, -1, px.data(), px.numel());\n        // px {W_px, H_px, T_px, 3}:')
    edits[p] = s
    p = root / 'src/core/ggml_extend.hpp'
    s = replace_once(p.read_text(), '#include "ggml-alloc.h"', '#include "core/abot_diagnostics.h"\n#include "ggml-alloc.h"')
    s = replace_once(s, '        ggml_status status;\n', '        abot_diag_sync(runtime_backend, "before-graph");\n        ggml_status status;\n')
    s = replace_once(s, '        if (status != GGML_STATUS_SUCCESS) {\n            LOG_ERROR("%s compute failed:', '        abot_diag_sync(runtime_backend, "after-graph");\n        if (status != GGML_STATUS_SUCCESS) {\n            LOG_ERROR("%s compute failed:')
    s = replace_once(s, '            ggml_backend_tensor_copy(src, dst);\n            it = pending_persistent_cache_.erase(it);', '            abot_diag_event("kv-copy", dst->data, ggml_nbytes(dst), it->first.c_str());\n            ggml_backend_tensor_copy(src, dst);\n            it = pending_persistent_cache_.erase(it);')
    edits[p] = s
    p = root / 'src/model_manager.cpp'
    s = replace_once(p.read_text(), '#include "model_manager.h"', '#include "model_manager.h"\n#include "core/abot_diagnostics.h"')
    s = replace_once(s, '            LOG_DEBUG("model manager prepared params backend buffer', '            abot_diag_event("weight-prepare", ggml_backend_buffer_get_base(block->buffer), ggml_backend_buffer_get_size(block->buffer));\n            LOG_DEBUG("model manager prepared params backend buffer')
    s = replace_once(s, '\n        LOG_DEBUG("model manager releasing params backend buffer', '\n        abot_diag_event("weight-release", ggml_backend_buffer_get_base(block.buffer), ggml_backend_buffer_get_size(block.buffer));\n        LOG_DEBUG("model manager releasing params backend buffer')
    edits[p] = s
    p = root / 'examples/abot-session/main.cpp'
    s = replace_once(p.read_text(), '#include <fstream>', '#include <fstream>\n#include <filesystem>\n#include "core/abot_diagnostics.h"')
    s = replace_once(s, 'int main(int argc, char** argv) {', '''int main(int argc, char** argv) {
#ifdef SD_ABOT_DIAGNOSTICS
    if (const char* module = std::getenv("SD_ABOT_DIAGNOSTIC_CPU_MODULE")) {
        if (!ggml_backend_load(module)) return 2;
    }
    if (const char* module = std::getenv("SD_ABOT_DIAGNOSTIC_CUDA_MODULE")) {
        if (!ggml_backend_load(module)) return 2;
    }
    if (std::getenv("SD_ABOT_DIAGNOSTIC_NODE") || std::getenv("SD_ABOT_DIAGNOSTIC_MMQ") || std::getenv("SD_ABOT_DIAGNOSTIC_TRACE")) sd_set_backend_eval_callback(abot_diag_node, nullptr);
#endif''')
    s = replace_once(s, '    if (mode == "create-scene") {', '''#ifdef SD_ABOT_DIAGNOSTICS
    if (mode == "diagnostic-parity") {
        if (dit.empty() || taehv.empty() || scene.empty() || backend != "cuda0") return 2;
        const std::string capture_root = outdir;
        const char* names[] = {"resident-no-kv", "stream-no-kv", "resident-kv", "stream-kv", "disk-kv"};
        for (int lane = 0; lane < 5; ++lane) {
            const std::string capture = capture_root + "/" + names[lane];
            std::filesystem::create_directories(capture);
            setenv("SD_ABOT_DIAGNOSTIC_DIR", capture.c_str(), 1);
            const bool streamed = lane == 1 || lane == 3;
            const std::string placement = lane == 4 ? "diffusion=disk" : streamed ? "diffusion=cpu" : "";
            const int status = run_walk(dit, taehv, scene, actions, capture, threads, seed, backend,
                                        lane >= 2, profile, local_attn_size, placement,
                                        lane == 0 || lane == 2 ? "" : "4", streamed);
            if (status) return status;
        }
        return 0;
    }
#endif
    if (mode == "create-scene") {''')
    edits[p] = s
    # Validate every anchor before changing any source file.
    for p, text in edits.items():
        p.write_text(text)
    shutil.copyfile(Path(__file__).with_name('diagnostics.h'), root / 'src/core/abot_diagnostics.h')
    shutil.copyfile(Path(__file__).with_name('abot_trace.h'), root / 'src/core/abot_trace.h')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('engine', type=Path)
    instrument(parser.parse_args().engine)
