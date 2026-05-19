#pragma once

#include <cstdint>
#include <vector>

#include <stable-diffusion.h>

namespace qvac_lib_inference_addon_sd {

/**
 * Encode a sequence of sd_image_t frames as an in-memory MJPG AVI video
 * (RIFF/AVI 1.0) using stb_image_write for per-frame JPEG compression.
 *
 * Port of qvac-ext-stable-diffusion.cpp/examples/cli/avi_writer.h, adapted
 * from a FILE*-based sink to a std::vector<uint8_t> sink so the addon can
 * deliver video bytes through the existing OutputCallBackJs queue without
 * touching disk.
 *
 * Layout produced (little-endian, byte-exact with the upstream CLI):
 *   RIFF ____ AVI
 *     LIST ____ hdrl
 *       avih (56 bytes)
 *       LIST ____ strl
 *         strh (56 bytes, vids / MJPG)
 *         strf (40 bytes, BITMAPINFOHEADER)
 *     LIST ____ movi
 *       00dc <size> <jpeg>   x num_frames (each 2-byte aligned)
 *     idx1 <size>
 *       00dc 0x10 <offset> <size>   x num_frames
 *
 * @param frames       Pointer to contiguous sd_image_t array. Every frame
 *                     must share the same width / height / channel count;
 *                     channels must be 3 (RGB) or 4 (RGBA, alpha dropped by
 *                     stbi_write_jpg_to_func).
 * @param numFrames    Number of frames. Must be > 0.
 * @param fps          Frames per second written into the AVI main header and
 *                     stream header. Must be > 0.
 * @param jpegQuality  JPEG quality (1-100); 90 is a reasonable default.
 * @return             Encoded AVI as a byte vector.
 *
 * @throws qvac_errors::StatusError on: numFrames == 0, fps <= 0, unsupported
 *         channel count, or JPEG encode failure.
 */
std::vector<uint8_t> encodeFramesToAvi(const sd_image_t *frames, int numFrames,
                                       int fps, int jpegQuality = 90);

} // namespace qvac_lib_inference_addon_sd
