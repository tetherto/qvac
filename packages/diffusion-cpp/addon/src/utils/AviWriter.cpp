#include "AviWriter.hpp"

#include <climits>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <inference-addon-cpp/Errors.hpp>
#include <stb_image_write.h>

namespace qvac_lib_inference_addon_sd {

using namespace qvac_errors;

namespace {

// ---------------------------------------------------------------------------
// Little-endian primitive appenders
// ---------------------------------------------------------------------------
// AVI is little-endian across every numeric field. On all platforms we target
// (macOS arm64, Linux x64, Android arm/arm64, Windows x64) native byte order
// is already little-endian, so the compiler collapses these to a memcpy. We
// still spell out the byte writes explicitly to stay portable.

inline void appendU16LE(std::vector<uint8_t>& out, uint16_t v) {
  out.push_back(static_cast<uint8_t>(v & 0xff));
  out.push_back(static_cast<uint8_t>((v >> 8) & 0xff));
}

inline void appendU32LE(std::vector<uint8_t>& out, uint32_t v) {
  out.push_back(static_cast<uint8_t>(v & 0xff));
  out.push_back(static_cast<uint8_t>((v >> 8) & 0xff));
  out.push_back(static_cast<uint8_t>((v >> 16) & 0xff));
  out.push_back(static_cast<uint8_t>((v >> 24) & 0xff));
}

inline void appendFourCC(std::vector<uint8_t>& out, const char fourcc[4]) {
  out.insert(out.end(), fourcc, fourcc + 4);
}

// Overwrite a previously reserved 4-byte u32 placeholder at `offset`.
inline void patchU32LEAt(std::vector<uint8_t>& out, size_t offset, uint32_t v) {
  out[offset + 0] = static_cast<uint8_t>(v & 0xff);
  out[offset + 1] = static_cast<uint8_t>((v >> 8) & 0xff);
  out[offset + 2] = static_cast<uint8_t>((v >> 16) & 0xff);
  out[offset + 3] = static_cast<uint8_t>((v >> 24) & 0xff);
}

struct AviIndexEntry {
  uint32_t offset;
  uint32_t size;
};

// stb_image_write_to_func callback context. Each frame encode appends raw
// JPEG bytes into its own vector so we can snapshot the size before writing
// the 00dc chunk header.
struct JpegSink {
  std::vector<uint8_t> bytes;
};

extern "C" void jpegSinkWriteCb(void* context, void* data, int size) {
  auto* sink = static_cast<JpegSink*>(context);
  const auto* bytes = static_cast<const uint8_t*>(data);
  sink->bytes.insert(sink->bytes.end(), bytes, bytes + size);
}

} // namespace

// ---------------------------------------------------------------------------
// encodeFramesToAvi -- main entry point
// ---------------------------------------------------------------------------

std::vector<uint8_t> encodeFramesToAvi(
    const sd_image_t* frames, int numFrames, int fps, int jpegQuality) {
  // -- Input validation ------------------------------------------------------
  if (!frames) {
    throw StatusError(
        general_error::InvalidArgument,
        "encodeFramesToAvi: frames pointer is null");
  }
  if (numFrames <= 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "encodeFramesToAvi: numFrames must be > 0, got " +
            std::to_string(numFrames));
  }
  if (fps <= 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "encodeFramesToAvi: fps must be > 0, got " + std::to_string(fps));
  }
  if (jpegQuality < 1 || jpegQuality > 100) {
    throw StatusError(
        general_error::InvalidArgument,
        "encodeFramesToAvi: jpegQuality must be in [1, 100], got " +
            std::to_string(jpegQuality));
  }

  const uint32_t width = frames[0].width;
  const uint32_t height = frames[0].height;
  const uint32_t channels = frames[0].channel;
  if (width == 0 || height == 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "encodeFramesToAvi: frame 0 has zero width or height");
  }
  if (channels != 3 && channels != 4) {
    throw StatusError(
        general_error::InvalidArgument,
        "encodeFramesToAvi: unsupported channel count " +
            std::to_string(channels) + " (only RGB=3 / RGBA=4 supported)");
  }

  // -- Build AVI in a single growable buffer ---------------------------------
  //
  // The reserve size below was previously computed as:
  //   512 + numFrames * width * height * 3
  // which can silently overflow size_t for large dimensions / long videos
  // (e.g. 4096x4096 x 200 frames overflows the 3-byte-per-pixel step on
  // 32-bit targets, and 64-bit targets still hit the 4 GB RIFF cap below).
  //
  // We perform the multiplication step-by-step against SIZE_MAX, and also
  // gate the final size against UINT32_MAX because RIFF stores file size
  // as a little-endian uint32_t -- anything past 4 GB cannot be addressed
  // by the AVI 1.0 spec regardless of host memory.
  constexpr size_t kHeaderBytes = 512;
  constexpr size_t kChunkOverhead = 16; // 4 fourcc + 4 size + alignment slack

  // width / height / channels are uint32_t (verified > 0 above), so each
  // step is unsigned with well-defined wrap semantics, but we still want to
  // reject overflow rather than wrap-around silently.
  const size_t wSz = static_cast<size_t>(width);
  const size_t hSz = static_cast<size_t>(height);
  if (wSz > SIZE_MAX / hSz || wSz > SIZE_MAX / 3 || wSz * hSz > SIZE_MAX / 3) {
    throw StatusError(
        general_error::InvalidArgument,
        "encodeFramesToAvi: frame size " + std::to_string(width) + "x" +
            std::to_string(height) +
            " is too large -- width*height*3 would overflow size_t");
  }
  const size_t bytesPerFrame = wSz * hSz * 3;
  const size_t perFrameWithOverhead = bytesPerFrame + kChunkOverhead;

  // bytesPerFrame is bounded by `estimated <= UINT32_MAX` below, so this
  // cast is safe and equals the AVI 1.0 "biSizeImage" / suggested-buffer
  // value used in three header fields.
  const auto suggestedBufferSize = static_cast<uint32_t>(bytesPerFrame);

  const size_t framesSz = static_cast<size_t>(numFrames);
  if (framesSz > (SIZE_MAX - kHeaderBytes) / perFrameWithOverhead) {
    throw StatusError(
        general_error::InvalidArgument,
        "encodeFramesToAvi: " + std::to_string(numFrames) + " frames at " +
            std::to_string(width) + "x" + std::to_string(height) +
            " would overflow buffer size");
  }

  const size_t estimated = kHeaderBytes + framesSz * perFrameWithOverhead;
  // AVI 1.0 stores RIFF/LIST sizes as uint32 -- anything past 4 GB cannot
  // be represented in the header even if we had the RAM.
  if (estimated > static_cast<size_t>(UINT32_MAX)) {
    throw StatusError(
        general_error::InvalidArgument,
        "encodeFramesToAvi: estimated output (" + std::to_string(estimated) +
            " bytes) exceeds the AVI 1.0 4 GB RIFF size limit");
  }

  std::vector<uint8_t> out;
  out.reserve(estimated);

  // RIFF ____ AVI
  appendFourCC(out, "RIFF");
  const size_t riffSizePos = out.size();
  appendU32LE(out, 0); // placeholder - patched after all frames written
  appendFourCC(out, "AVI ");

  // LIST hdrl (size == 4 + (8 + 56) + (8 + 4 + (8 + 56) + (8 + 40)))
  //           == 4 + 8 + 56 + 8 + 4 + 8 + 56 + 8 + 40 = 192
  appendFourCC(out, "LIST");
  appendU32LE(out, 4 + 8 + 56 + 8 + 4 + 8 + 56 + 8 + 40);
  appendFourCC(out, "hdrl");

  // avih (AVI main header, 56 bytes)
  appendFourCC(out, "avih");
  appendU32LE(out, 56);
  appendU32LE(out, 1000000u / static_cast<uint32_t>(fps)); // us per frame
  appendU32LE(out, 0);                                     // max bytes/sec
  appendU32LE(out, 0);     // padding granularity
  appendU32LE(out, 0x110); // flags: HASINDEX | ISINTERLEAVED
  appendU32LE(out, static_cast<uint32_t>(numFrames)); // total frames
  appendU32LE(out, 0);                                // initial frames
  appendU32LE(out, 1);                                // number of streams
  appendU32LE(out, suggestedBufferSize);              // suggested buffer size
  appendU32LE(out, width);
  appendU32LE(out, height);
  appendU32LE(out, 0); // reserved
  appendU32LE(out, 0); // reserved
  appendU32LE(out, 0); // reserved
  appendU32LE(out, 0); // reserved

  // LIST strl
  appendFourCC(out, "LIST");
  appendU32LE(out, 4 + 8 + 56 + 8 + 40);
  appendFourCC(out, "strl");

  // strh (stream header, 56 bytes)
  appendFourCC(out, "strh");
  appendU32LE(out, 56);
  appendFourCC(out, "vids");                          // stream type: video
  appendFourCC(out, "MJPG");                          // codec: Motion JPEG
  appendU32LE(out, 0);                                // flags
  appendU16LE(out, 0);                                // priority
  appendU16LE(out, 0);                                // language
  appendU32LE(out, 0);                                // initial frames
  appendU32LE(out, 1);                                // scale
  appendU32LE(out, static_cast<uint32_t>(fps));       // rate
  appendU32LE(out, 0);                                // start
  appendU32LE(out, static_cast<uint32_t>(numFrames)); // length
  appendU32LE(out, suggestedBufferSize);              // suggested buffer size
  appendU32LE(out, 0xFFFFFFFFu); // quality (== -1 "default")
  appendU32LE(out, 0);           // sample size
  appendU16LE(out, 0);           // rcFrame.left
  appendU16LE(out, 0);           // rcFrame.top
  appendU16LE(out, 0);           // rcFrame.right
  appendU16LE(out, 0);           // rcFrame.bottom

  // strf (stream format: BITMAPINFOHEADER, 40 bytes)
  appendFourCC(out, "strf");
  appendU32LE(out, 40);
  appendU32LE(out, 40); // biSize
  appendU32LE(out, width);
  appendU32LE(out, height);
  appendU16LE(out, 1);                   // biPlanes
  appendU16LE(out, 24);                  // biBitCount
  appendFourCC(out, "MJPG");             // biCompression (FOURCC)
  appendU32LE(out, suggestedBufferSize); // biSizeImage
  appendU32LE(out, 0);                   // XPelsPerMeter
  appendU32LE(out, 0);                   // YPelsPerMeter
  appendU32LE(out, 0);                   // colors used
  appendU32LE(out, 0);                   // colors important

  // LIST movi
  appendFourCC(out, "LIST");
  const size_t moviSizePos = out.size();
  appendU32LE(out, 0); // placeholder
  appendFourCC(out, "movi");

  // -- Encode and append each frame as an "00dc" chunk -----------------------
  std::vector<AviIndexEntry> index;
  index.reserve(static_cast<size_t>(numFrames));

  for (int i = 0; i < numFrames; ++i) {
    const sd_image_t& f = frames[i];

    // Enforce frame homogeneity: upstream AVI has a single BITMAPINFOHEADER,
    // so mixed dimensions or channel counts would corrupt the stream.
    if (f.width != width || f.height != height || f.channel != channels) {
      throw StatusError(
          general_error::InvalidArgument,
          "encodeFramesToAvi: frame " + std::to_string(i) +
              " dimensions or channel count differ from frame 0");
    }
    if (!f.data) {
      throw StatusError(
          general_error::InvalidArgument,
          "encodeFramesToAvi: frame " + std::to_string(i) + " data is null");
    }

    JpegSink sink;
    const int rc = stbi_write_jpg_to_func(
        &jpegSinkWriteCb,
        &sink,
        static_cast<int>(f.width),
        static_cast<int>(f.height),
        static_cast<int>(f.channel),
        f.data,
        jpegQuality);
    if (rc == 0 || sink.bytes.empty()) {
      throw StatusError(
          general_error::InternalError,
          "encodeFramesToAvi: stbi_write_jpg_to_func failed for frame " +
              std::to_string(i));
    }

    // "00dc" (video frame chunk)
    appendFourCC(out, "00dc");
    const uint32_t jpegSize = static_cast<uint32_t>(sink.bytes.size());
    appendU32LE(out, jpegSize);
    AviIndexEntry entry{};
    entry.offset = static_cast<uint32_t>(out.size() - 8 - moviSizePos - 4);
    // ^ offset is relative to start of 'movi' payload per AVI 1.0 idx1 spec;
    //   many players accept either absolute file offsets or movi-relative,
    //   and stb-generated MJPG AVIs historically use movi-relative. See
    //   https://learn.microsoft.com/en-us/windows/win32/directshow/avi-riff-file-reference
    entry.size = jpegSize;
    index.push_back(entry);

    out.insert(out.end(), sink.bytes.begin(), sink.bytes.end());

    // Align chunk to even size per RIFF spec
    if (jpegSize % 2) {
      out.push_back(0);
    }
  }

  // Finalize movi size (total bytes in LIST payload, not counting the LIST
  // chunk header and the 4-byte size field itself)
  {
    const uint32_t moviSize =
        static_cast<uint32_t>(out.size() - moviSizePos - 4);
    patchU32LEAt(out, moviSizePos, moviSize);
  }

  // -- Write idx1 index ------------------------------------------------------
  appendFourCC(out, "idx1");
  appendU32LE(out, static_cast<uint32_t>(numFrames) * 16);
  for (const auto& entry : index) {
    appendFourCC(out, "00dc");
    appendU32LE(out, 0x10); // AVIIF_KEYFRAME
    appendU32LE(out, entry.offset);
    appendU32LE(out, entry.size);
  }

  // Finalize RIFF size (total file size minus 8 bytes of "RIFF<size>").
  // The pre-flight estimate above bounds this, but the final length depends
  // on JPEG compression so re-check before truncating to uint32_t.
  {
    const size_t riffPayload = out.size() - riffSizePos - 4;
    if (riffPayload > static_cast<size_t>(UINT32_MAX)) {
      throw StatusError(
          general_error::InternalError,
          "encodeFramesToAvi: produced AVI of " + std::to_string(out.size()) +
              " bytes exceeds the AVI 1.0 4 GB RIFF size limit");
    }
    patchU32LEAt(out, riffSizePos, static_cast<uint32_t>(riffPayload));
  }

  return out;
}

} // namespace qvac_lib_inference_addon_sd
