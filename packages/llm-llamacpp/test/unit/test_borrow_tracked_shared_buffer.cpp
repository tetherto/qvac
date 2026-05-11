#include <memory>
#include <sstream>
#include <utility>

#include <gtest/gtest.h>

#include "utils/BorrowablePtr.hpp"

TEST(BorrowablePtrTest, ReclaimThrowsWhileBorrowIsActive) {
  auto shard = std::make_unique<std::stringbuf>("abc");
  BorrowablePtr<std::basic_streambuf<char>> buffer(std::move(shard));
  auto lease = buffer.borrow();
  ASSERT_TRUE(static_cast<bool>(lease));

  EXPECT_THROW(buffer.reclaimUnique(), std::runtime_error);

  lease = {};
  auto unique = buffer.reclaimUnique();
  EXPECT_NE(unique, nullptr);
}

TEST(BorrowablePtrTest, BorrowIsEmptyAfterOwnershipMovedOut) {
  auto shard = std::make_unique<std::stringbuf>("abc");
  BorrowablePtr<std::basic_streambuf<char>> buffer(std::move(shard));

  auto unique = buffer.reclaimUnique();
  EXPECT_NE(unique, nullptr);

  auto lease = buffer.borrow();
  EXPECT_FALSE(static_cast<bool>(lease));
}

TEST(BorrowablePtrTest, ReclaimTwiceReturnsNullSecondTime) {
  auto shard = std::make_unique<std::stringbuf>("abc");
  BorrowablePtr<std::basic_streambuf<char>> buffer(std::move(shard));

  auto first = buffer.reclaimUnique();
  EXPECT_NE(first, nullptr);

  auto second = buffer.reclaimUnique();
  EXPECT_EQ(second, nullptr);
}

TEST(BorrowablePtrTest, ConstructorRejectsNullUniquePtr) {
  std::unique_ptr<std::basic_streambuf<char>> nullBuf;
  EXPECT_THROW(
      BorrowablePtr<std::basic_streambuf<char>>(std::move(nullBuf)),
      std::invalid_argument);
}

TEST(BorrowablePtrTest, MoveTransfersOwnershipAndBorrowability) {
  auto shard = std::make_unique<std::stringbuf>("abc");
  BorrowablePtr<std::basic_streambuf<char>> src(std::move(shard));

  BorrowablePtr<std::basic_streambuf<char>> dst(std::move(src));

  auto movedFromLease = src.borrow();
  EXPECT_FALSE(static_cast<bool>(movedFromLease));

  auto movedToLease = dst.borrow();
  EXPECT_TRUE(static_cast<bool>(movedToLease));
}
