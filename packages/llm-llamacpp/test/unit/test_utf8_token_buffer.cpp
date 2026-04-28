#include <string>

#include <gtest/gtest.h>

#include "utils/UTF8TokenBuffer.hpp"

using namespace qvac_lib_inference_addon_llama;

class UTF8TokenBufferTest : public ::testing::Test {
protected:
  UTF8TokenBuffer buffer;
};

TEST_F(UTF8TokenBufferTest, BasicASCII) {
  std::string result = buffer.addToken("Hello");
  EXPECT_EQ(result, "Hello");
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, CompleteTwoByteSequence) {
  std::string token = "\xC3\xB1";
  std::string result = buffer.addToken(token);
  EXPECT_EQ(result, token);
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, CompleteThreeByteSequence) {
  std::string token = "\xE4\xB8\xAD";
  std::string result = buffer.addToken(token);
  EXPECT_EQ(result, token);
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, CompleteFourByteSequence) {
  std::string token = "\xF0\x9F\x98\x80";
  std::string result = buffer.addToken(token);
  EXPECT_EQ(result, token);
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, IncompleteSequenceSplitAcrossTokens) {
  std::string token1 = "\xC3";
  std::string result1 = buffer.addToken(token1);
  EXPECT_EQ(result1, "");
  EXPECT_TRUE(buffer.hasPendingBytes());

  std::string token2 = "\xB1";
  std::string result2 = buffer.addToken(token2);
  EXPECT_EQ(result2, "\xC3\xB1");
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, IncompleteEmojiSplitAcrossTokens) {
  std::string token1 = "\xF0";
  std::string result1 = buffer.addToken(token1);
  EXPECT_EQ(result1, "");
  EXPECT_TRUE(buffer.hasPendingBytes());

  std::string token2 = "\x9F";
  std::string result2 = buffer.addToken(token2);
  EXPECT_EQ(result2, "");
  EXPECT_TRUE(buffer.hasPendingBytes());

  std::string token3 = "\x98";
  std::string result3 = buffer.addToken(token3);
  EXPECT_EQ(result3, "");
  EXPECT_TRUE(buffer.hasPendingBytes());

  std::string token4 = "\x80";
  std::string result4 = buffer.addToken(token4);
  EXPECT_EQ(result4, "\xF0\x9F\x98\x80");
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, MixedASCIIAndUTF8) {
  std::string token1 = "Hello";
  std::string result1 = buffer.addToken(token1);
  EXPECT_EQ(result1, "Hello");
  EXPECT_FALSE(buffer.hasPendingBytes());

  std::string token2 = "\xC3\xB1";
  std::string result2 = buffer.addToken(token2);
  EXPECT_EQ(result2, token2);
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, MultipleCompleteSequences) {
  std::string token = "Hello\xC3\xB1\xE4\xB8\xAD";
  std::string result = buffer.addToken(token);
  EXPECT_EQ(result, token);
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, FlushIncompleteSequence) {
  std::string token1 = "\xC3";
  buffer.addToken(token1);
  EXPECT_TRUE(buffer.hasPendingBytes());

  std::string flushed = buffer.flush();
  EXPECT_EQ(flushed, "\xC3");
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, FlushEmptyBuffer) {
  std::string flushed = buffer.flush();
  EXPECT_EQ(flushed, "");
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, ClearBuffer) {
  std::string token1 = "\xC3";
  buffer.addToken(token1);
  EXPECT_TRUE(buffer.hasPendingBytes());

  buffer.clear();
  EXPECT_FALSE(buffer.hasPendingBytes());

  std::string flushed = buffer.flush();
  EXPECT_EQ(flushed, "");
}

TEST_F(UTF8TokenBufferTest, InvalidStartByte) {
  std::string token = "\xFF";
  std::string result = buffer.addToken(token);
  EXPECT_EQ(result, "");
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, InvalidContinuationByte) {
  std::string token = "\xC3\xFF";
  std::string result = buffer.addToken(token);
  EXPECT_EQ(result, "");
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, ExtractCompleteCharsDirect) {
  buffer.addToken("\xC3");
  EXPECT_TRUE(buffer.hasPendingBytes());

  std::string result = buffer.extractCompleteChars();
  EXPECT_EQ(result, "");
  EXPECT_TRUE(buffer.hasPendingBytes());

  result = buffer.addToken("\xB1");
  EXPECT_EQ(result, "\xC3\xB1");
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, MultipleIncompleteSequences) {
  buffer.addToken("\xF0");
  EXPECT_TRUE(buffer.hasPendingBytes());

  buffer.addToken("\x9F");
  buffer.addToken("\x98");
  EXPECT_TRUE(buffer.hasPendingBytes());

  std::string result = buffer.addToken("\x80");
  EXPECT_EQ(result, "\xF0\x9F\x98\x80");
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, RealWorldEmojiScenario) {
  std::string result1 = buffer.addToken("Hello ");
  EXPECT_EQ(result1, "Hello ");
  EXPECT_FALSE(buffer.hasPendingBytes());

  buffer.addToken("\xF0");
  EXPECT_TRUE(buffer.hasPendingBytes());
  buffer.addToken("\x9F");
  EXPECT_TRUE(buffer.hasPendingBytes());
  buffer.addToken("\x98");
  EXPECT_TRUE(buffer.hasPendingBytes());
  std::string result2 = buffer.addToken("\x80");
  EXPECT_EQ(result2, "\xF0\x9F\x98\x80");
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, HasPendingBytes) {
  EXPECT_FALSE(buffer.hasPendingBytes());

  buffer.addToken("\xC3");
  EXPECT_TRUE(buffer.hasPendingBytes());

  buffer.addToken("\xB1");
  EXPECT_FALSE(buffer.hasPendingBytes());
}

TEST_F(UTF8TokenBufferTest, ComplexMixedScenario) {
  std::string result1 = buffer.addToken("A");
  EXPECT_EQ(result1, "A");
  EXPECT_FALSE(buffer.hasPendingBytes());

  buffer.addToken("\xC3");
  EXPECT_TRUE(buffer.hasPendingBytes());

  std::string result2 = buffer.addToken("\xB1\x42\xE4\xB8\xAD");
  EXPECT_EQ(result2, "\xC3\xB1\x42\xE4\xB8\xAD");
  EXPECT_FALSE(buffer.hasPendingBytes());
}
