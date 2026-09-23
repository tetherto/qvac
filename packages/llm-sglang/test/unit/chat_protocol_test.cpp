#include "http/HttpClient.hpp"
#include "protocol/ChatProtocol.hpp"

#include <gtest/gtest.h>

#include <stdexcept>
#include <string>
#include <vector>

using qvac_llm_sglang::ChatTurn;
using qvac_llm_sglang::ChunkedDecoder;
using qvac_llm_sglang::ContentPart;
using qvac_llm_sglang::MediaKind;
using qvac_llm_sglang::SamplingParams;
using qvac_llm_sglang::SseParser;
using qvac_llm_sglang::buildChatBody;
using qvac_llm_sglang::parseHttpEndpoint;

namespace {

ChatTurn textTurn(std::string role, std::string text) {
  ChatTurn turn;
  turn.role = std::move(role);
  ContentPart part;
  part.text = std::move(text);
  turn.parts.push_back(std::move(part));
  return turn;
}

} // namespace

TEST(ChatBody, TextMessageAndSampling) {
  SamplingParams sampling;
  sampling.temperature = 0.5;
  sampling.maxTokens = 16;
  sampling.jsonSchema = "{\"type\":\"object\"}";
  const std::string body =
      buildChatBody({textTurn("user", "hello \"world\"")}, sampling);

  EXPECT_NE(body.find("\"role\":\"user\""), std::string::npos);
  EXPECT_NE(body.find("\"content\":\"hello \\\"world\\\"\""), std::string::npos);
  EXPECT_NE(body.find("\"stream\":true"), std::string::npos);
  EXPECT_NE(body.find("\"temperature\":0.5"), std::string::npos);
  EXPECT_NE(body.find("\"max_tokens\":16"), std::string::npos);
  EXPECT_NE(
      body.find("\"json_schema\":\"{\\\"type\\\":\\\"object\\\"}\""),
      std::string::npos);
}

TEST(ChatBody, ImageBytesBecomeDataUrl) {
  ChatTurn turn;
  turn.role = "user";
  ContentPart part;
  part.media = MediaKind::Image;
  part.bytes = {1, 2, 3};
  turn.parts.push_back(std::move(part));

  const std::string body = buildChatBody({turn}, {});
  EXPECT_NE(
      body.find(
          "\"type\":\"image_url\",\"image_url\":{\"url\":\"data:application/"
          "octet-stream;base64,AQID\"}"),
      std::string::npos);
}

TEST(ChatBody, ImagePathBecomesFileUrl) {
  ChatTurn turn;
  turn.role = "user";
  ContentPart part;
  part.media = MediaKind::Image;
  part.path = "/models/cat photo.png";
  turn.parts.push_back(std::move(part));

  const std::string body = buildChatBody({turn}, {});
  EXPECT_NE(
      body.find("file:///models/cat%20photo.png"), std::string::npos);
}

TEST(ChatBody, PngMime) {
  ChatTurn turn;
  turn.role = "user";
  ContentPart part;
  part.media = MediaKind::Image;
  part.bytes = {0x89, 'P', 'N', 'G', 0, 0, 0, 0};
  turn.parts.push_back(std::move(part));
  EXPECT_NE(buildChatBody({turn}, {}).find("data:image/png;base64,"), std::string::npos);
}

TEST(ChatBody, RejectsAudioAndVideo) {
  for (const auto kind : {MediaKind::Audio, MediaKind::Video}) {
    ChatTurn turn;
    turn.role = "user";
    ContentPart part;
    part.media = kind;
    part.path = "/tmp/clip";
    turn.parts.push_back(std::move(part));
    EXPECT_THROW(buildChatBody({turn}, {}), std::invalid_argument);
  }
}

TEST(ChatBody, RejectsEmptyMessages) {
  EXPECT_THROW(buildChatBody({}, {}), std::invalid_argument);
}

TEST(SseParser, ContentDeltasAndDone) {
  SseParser parser;
  const auto first = parser.feed(
      "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n"
      "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n");
  ASSERT_EQ(first.size(), 1u);
  EXPECT_EQ(first[0], "hel");

  const auto second = parser.feed(
      "data: {\"choices\":[{\"delta\":{\"content\":\"lo\\\"!\"}}]}\n\n"
      "data: [DONE]\n\n");
  ASSERT_EQ(second.size(), 1u);
  EXPECT_EQ(second[0], "lo\"!");
  EXPECT_TRUE(parser.done());
}

TEST(SseParser, IgnoresReasoningContent) {
  SseParser parser;
  const auto deltas = parser.feed(
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n\n");
  EXPECT_TRUE(deltas.empty());
}

TEST(SseParser, SplitChunkAndServerError) {
  SseParser parser;
  EXPECT_TRUE(parser.feed("data: {\"choices\":[{\"delta\":{\"content\":").empty());
  const auto deltas = parser.feed("\"yo\"}}]}\n\n");
  ASSERT_EQ(deltas.size(), 1u);
  EXPECT_EQ(deltas[0], "yo");

  EXPECT_THROW(
      parser.feed(
          "data: {\"error\":{\"message\":\"image parts require a vision-capable native model adapter\",\"type\":\"invalid_request_error\"}}\n\n"),
      std::runtime_error);
}

TEST(ChunkedDecoder, DecodesSplitBody) {
  ChunkedDecoder decoder;
  std::string out;
  decoder.feed("4\r\nWi", out);
  EXPECT_EQ(out, "");
  decoder.feed("ki\r\n5\r\npedia\r\n0\r\n\r\n", out);
  EXPECT_EQ(out, "Wikipedia");
  EXPECT_TRUE(decoder.finished());
}

TEST(Endpoint, ParsesHostAndPort) {
  const auto endpoint = parseHttpEndpoint("http://127.0.0.1:30000");
  EXPECT_EQ(endpoint.host, "127.0.0.1");
  EXPECT_EQ(endpoint.port, 30000);
  EXPECT_THROW(parseHttpEndpoint("https://127.0.0.1:30000"), std::invalid_argument);
}
