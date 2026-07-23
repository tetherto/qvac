#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

/// Whether a media marker is satisfied by a hoisted byte buffer (carried out
/// of band in `Prompt::media`) or by an inline file path.
enum class MediaSource : uint8_t { ByteBuffer, Path };

/// One media marker in prompt order. `path` is set iff `source == Path`.
struct PlannedMedia {
  MediaSource source;
  std::string path;
};

/// One media load step. A `ByteBuffer` step consumes the next hoisted buffer
/// from the request's `media` vector (`byteIndex` into it); a `Path` step names
/// the file to load. Steps are returned in prompt-marker order so bitmaps bind
/// to the correct markers. Used by both the single-prompt and batch paths.
struct MediaLoadStep {
  MediaSource source;
  size_t byteIndex;
  std::string path;
};

/// Throw StatusError(InvalidArgument) when the number of byte-buffer markers
/// in `plan` does not equal `bufferCount`. Call before any loadMedia loop to
/// catch both missing-buffer and surplus-buffer mismatches.
void validateByteBufferCount(
    const std::vector<PlannedMedia>& plan, size_t bufferCount);

/// Turn an ordered media plan into a load sequence. Byte-buffer markers are
/// assigned ascending `byteIndex` (0, 1, 2…) in the order they appear in
/// `plan`; path markers carry their path. The output preserves `plan` order.
std::vector<MediaLoadStep>
computeMediaLoadOrder(const std::vector<PlannedMedia>& plan);
