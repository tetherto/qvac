#include <cstdint>
#include <any>
#include <fstream>
#include <iostream>
#include <memory>
#include <string>
#include <vector>
#include <chrono>

#include "model-interface/SdModel.hpp"

// Load image file (PNG/JPEG) into bytes
std::vector<uint8_t> loadImageFile(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file.is_open()) {
    throw std::runtime_error("Failed to open image: " + path);
  }
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(file)),
                               std::istreambuf_iterator<char>());
}

// Save AVI bytes to file
void saveAvi(const std::string& path, const std::vector<uint8_t>& avi_bytes) {
  std::ofstream file(path, std::ios::binary);
  if (!file.is_open()) {
    throw std::runtime_error("Failed to open output file: " + path);
  }
  file.write(reinterpret_cast<const char*>(avi_bytes.data()), avi_bytes.size());
  file.close();
  std::cout << "Saved → " << path << " (" << avi_bytes.size() << " bytes)\n";
}

int main(int argc, char* argv[]) {
  try {
    // ── Paths ─────────────────────────────────────────────────────────────
    std::string models_dir = "../models";
    std::string assets_dir = "../assets";
    std::string output_dir = "../output";

    std::string diffusion_model = models_dir + "/wan2.1_t2v_1.3B_fp16.safetensors";
    std::string vae_model = models_dir + "/wan_2.1_vae.safetensors";
    std::string t5xxl_model = models_dir + "/umt5_xxl_fp16.safetensors";
    std::string init_image_path = assets_dir + "/von-neumann.jpg";

    // ── Generation params ──────────────────────────────────────────────────
    const int width = 480;
    const int height = 608;
    const int video_frames = 33;
    const int fps = 16;
    const int steps = 30;
    const float cfg_scale = 6.0f;
    const float flow_shift = 3.0f;
    const float strength = 0.8f;
    const int seed = 42;

    const std::string prompt =
        "the man slowly turns his head and blinks, soft natural lighting, "
        "subtle camera push-in, fine film grain, cinematic";
    const std::string neg_prompt =
        "blurry, distorted, low quality, jittery, static, frozen, "
        "watermark, double face, extra limbs";

    std::cout << "Wan 2.1 T2V 1.3B — image-to-video inference (C++ standalone)\n";
    std::cout << "===========================================================\n";
    std::cout << "Model      : " << diffusion_model << "\n";
    std::cout << "Init image : " << init_image_path << "\n";
    std::cout << "Prompt     : " << prompt << "\n";
    std::cout << "Size       : " << width << "x" << height << "\n";
    std::cout << "Frames     : " << video_frames << " (@" << fps << " fps → "
              << (video_frames / (float)fps) << "s)\n";
    std::cout << "Steps      : " << steps << "\n";
    std::cout << "Strength   : " << strength << "\n";
    std::cout << "Seed       : " << seed << "\n\n";

    // ── Load init image ────────────────────────────────────────────────────
    auto init_image_bytes = loadImageFile(init_image_path);
    std::cout << "Loaded init image: " << init_image_bytes.size() << " bytes\n\n";

    // ── Create model ───────────────────────────────────────────────────────
    std::cout << "Creating Wan video model...\n";
    qvac_lib_inference_addon_cpp::SdCtxConfig config;
    config.diffusionModelPath = diffusion_model;
    config.vaePath = vae_model;
    config.t5XxlPath = t5xxl_model;
    config.nThreads = 4;
    config.device = "gpu";
    config.diffusionFlashAttn = true;
    config.offloadToCpu = true;

    auto model = std::make_unique<qvac_lib_inference_addon_cpp::SdModel>(config);

    std::cout << "Loading Wan 2.1 T2V 1.3B weights...\n";
    model->load();
    std::cout << "Model loaded.\n\n";

    // ── Build generation params ────────────────────────────────────────────
    std::string params_json = R"({
      "mode": "img2vid",
      "prompt": ")" +
                             prompt + R"(",
      "negative_prompt": ")" +
                             neg_prompt + R"(",
      "width": )" +
                             std::to_string(width) + R"(,
      "height": )" +
                             std::to_string(height) + R"(,
      "video_frames": )" +
                             std::to_string(video_frames) + R"(,
      "fps": )" +
                             std::to_string(fps) + R"(,
      "steps": )" +
                             std::to_string(steps) + R"(,
      "cfg_scale": )" +
                             std::to_string(cfg_scale) + R"(,
      "flow_shift": )" +
                             std::to_string(flow_shift) + R"(,
      "strength": )" +
                             std::to_string(strength) + R"(,
      "seed": )" +
                             std::to_string(seed) + R"(
    })";

    // ── Run generation ─────────────────────────────────────────────────────
    std::cout << "Starting img2vid generation...\n";
    auto t_gen_start = std::chrono::steady_clock::now();
    int progress_ticks = 0;

    qvac_lib_inference_addon_cpp::SdModel::GenerationJob job;
    job.paramsJson = params_json;
    job.initImageBytes = init_image_bytes;

    std::vector<uint8_t> avi_output;

    job.progressCallback = [&](const std::string& tick_json) {
      ++progress_ticks;
      if (progress_ticks % 5 == 0) {
        std::cout << "  Progress tick " << progress_ticks << "\n";
      }
    };

    job.outputCallback = [&](const std::vector<uint8_t>& bytes) {
      avi_output = bytes;
      std::cout << "  Output callback fired: " << bytes.size() << " bytes\n";
    };

    job.frameCallback =
        [&](const std::vector<uint8_t>& /*png*/, int idx, int total) {
          if (idx == 0 || idx == total - 1) {
            std::cout << "  Frame " << idx << "/" << total << "\n";
          }
        };

    model->process(std::any(job));

    auto t_gen_end = std::chrono::steady_clock::now();
    auto gen_time_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(t_gen_end -
                                                               t_gen_start)
            .count();

    std::cout << "\nGenerated in " << (gen_time_ms / 1000.0) << "s\n";
    std::cout << "Progress ticks: " << progress_ticks << "\n";

    // ── Save output ────────────────────────────────────────────────────────
    if (!avi_output.empty()) {
      std::string out_path =
          output_dir + "/wan_img2vid_cpp_seed" + std::to_string(seed) + ".avi";
      saveAvi(out_path, avi_output);
    } else {
      std::cerr << "ERROR: No AVI output received!\n";
      return 1;
    }

    // ── Cleanup ────────────────────────────────────────────────────────────
    std::cout << "\nUnloading model...\n";
    model->unload();
    std::cout << "Done.\n";

    return 0;

  } catch (const std::exception& e) {
    std::cerr << "Fatal: " << e.what() << "\n";
    return 1;
  }
}
