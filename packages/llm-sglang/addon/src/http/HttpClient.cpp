#include "http/HttpClient.hpp"

#include <cerrno>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <utility>

#if !defined(_WIN32)
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace qvac_llm_sglang {
namespace {

class Socket {
 public:
  explicit Socket(int fd) : fd_(fd) {}
  Socket(const Socket&) = delete;
  Socket& operator=(const Socket&) = delete;
  ~Socket() {
    if (fd_ >= 0) {
#if !defined(_WIN32)
      ::close(fd_);
#endif
    }
  }
  [[nodiscard]] int get() const { return fd_; }
  int release() {
    const int fd = fd_;
    fd_ = -1;
    return fd;
  }

 private:
  int fd_;
};

std::string httpErrorMessage(std::string_view body) {
  const std::string pattern = "\"message\":";
  const auto pos = body.find(pattern);
  if (pos == std::string_view::npos) {
    return std::string(body);
  }
  std::size_t i = pos + pattern.size();
  while (i < body.size() &&
         (body[i] == ' ' || body[i] == '\t')) {
    ++i;
  }
  if (i >= body.size() || body[i] != '"') {
    return std::string(body);
  }
  std::string message;
  for (++i; i < body.size(); ++i) {
    if (body[i] == '\\' && i + 1 < body.size()) {
      message.push_back(body[++i]);
      continue;
    }
    if (body[i] == '"') {
      return message;
    }
    message.push_back(body[i]);
  }
  return std::string(body);
}

#if !defined(_WIN32)

bool sendAll(int fd, std::string_view data) {
  while (!data.empty()) {
    const ssize_t n = ::send(fd, data.data(), data.size(), MSG_NOSIGNAL);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      return false;
    }
    data.remove_prefix(static_cast<std::size_t>(n));
  }
  return true;
}

int statusCode(std::string_view headers) {
  const auto lineEnd = headers.find("\r\n");
  const std::string_view line = headers.substr(0, lineEnd);
  const auto first = line.find(' ');
  if (first == std::string_view::npos) {
    throw std::runtime_error("malformed HTTP status line");
  }
  const auto second = line.find(' ', first + 1);
  const auto code = line.substr(
      first + 1, second == std::string_view::npos ? std::string_view::npos
                                                  : second - first - 1);
  return std::stoi(std::string(code));
}

bool headerValue(
    std::string_view headers, std::string_view name, std::string& value) {
  std::string key = "\r\n";
  key.append(name);
  key.push_back(':');
  auto pos = headers.find(key);
  if (pos == std::string_view::npos) {
    if (headers.size() >= name.size() &&
        headers.substr(0, name.size()) == name &&
        headers.size() > name.size() && headers[name.size()] == ':') {
      pos = 0;
      key = std::string(name) + ":";
    } else {
      return false;
    }
  }
  std::size_t i = pos + key.size();
  while (i < headers.size() && (headers[i] == ' ' || headers[i] == '\t')) {
    ++i;
  }
  const auto end = headers.find("\r\n", i);
  value = std::string(headers.substr(i, end - i));
  return true;
}

#endif

} // namespace

void CancelState::request() const {
  epoch_.fetch_add(1, std::memory_order_acq_rel);
  std::lock_guard lock(mutex_);
  if (fd_ >= 0) {
#if !defined(_WIN32)
    ::shutdown(fd_, SHUT_RDWR);
#endif
  }
}

void CancelState::arm(int socket, std::uint64_t seen) const {
  std::lock_guard lock(mutex_);
  fd_ = socket;
  if (epoch_.load(std::memory_order_acquire) != seen && fd_ >= 0) {
#if !defined(_WIN32)
    ::shutdown(fd_, SHUT_RDWR);
#endif
  }
}

void CancelState::disarm() const {
  std::lock_guard lock(mutex_);
  fd_ = -1;
}

Endpoint parseHttpEndpoint(const std::string& baseUrl) {
  constexpr std::string_view kScheme = "http://";
  if (baseUrl.rfind(kScheme, 0) != 0) {
    throw std::invalid_argument("baseUrl must be an http://host:port URL");
  }
  std::string rest = baseUrl.substr(kScheme.size());
  if (rest.empty() || rest.find('/') != std::string::npos) {
    throw std::invalid_argument("baseUrl must be an http://host:port URL");
  }
  const auto colon = rest.rfind(':');
  if (colon == std::string::npos || colon == 0 || colon + 1 >= rest.size()) {
    throw std::invalid_argument("baseUrl must include a port");
  }
  Endpoint endpoint;
  endpoint.host = rest.substr(0, colon);
  endpoint.port = std::stoi(rest.substr(colon + 1));
  if (endpoint.port <= 0 || endpoint.port > 65535) {
    throw std::invalid_argument("baseUrl port is invalid");
  }
  return endpoint;
}

void ChunkedDecoder::parse(std::string& out) {
  for (;;) {
    if (done_) {
      return;
    }
    if (!inData_) {
      const auto nl = pending_.find("\r\n");
      if (nl == std::string::npos) {
        return;
      }
      const std::string line = pending_.substr(0, nl);
      pending_.erase(0, nl + 2);
      const auto semi = line.find(';');
      const std::string sizeText =
          semi == std::string::npos ? line : line.substr(0, semi);
      std::size_t parsed = 0;
      remaining_ = std::stoul(sizeText, &parsed, 16);
      if (parsed != sizeText.size()) {
        throw std::runtime_error("malformed HTTP chunk size");
      }
      if (remaining_ == 0) {
        const auto trailer = pending_.find("\r\n");
        if (trailer == std::string::npos) {
          pending_.insert(0, "0\r\n");
          return;
        }
        pending_.erase(0, trailer + 2);
        done_ = true;
        return;
      }
      inData_ = true;
    }
    if (pending_.size() < remaining_ + 2) {
      return;
    }
    out.append(pending_, 0, remaining_);
    if (pending_.compare(remaining_, 2, "\r\n") != 0) {
      throw std::runtime_error("malformed HTTP chunk");
    }
    pending_.erase(0, remaining_ + 2);
    remaining_ = 0;
    inData_ = false;
  }
}

void ChunkedDecoder::feed(std::string_view raw, std::string& out) {
  pending_.append(raw);
  parse(out);
}

bool httpPost(
    const Endpoint& endpoint, const std::string& path, const std::string& body,
    const CancelState& cancel, std::uint64_t seen,
    const std::function<void(std::string_view)>& onBody) {
#if defined(_WIN32)
  (void)endpoint;
  (void)path;
  (void)body;
  (void)cancel;
  (void)seen;
  (void)onBody;
  throw std::runtime_error("the sglang HTTP client supports POSIX hosts");
#else
  if (cancel.stopped(seen)) {
    return false;
  }
  addrinfo hints{};
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_family = AF_UNSPEC;
  addrinfo* result = nullptr;
  const std::string port = std::to_string(endpoint.port);
  const int rc =
      ::getaddrinfo(endpoint.host.c_str(), port.c_str(), &hints, &result);
  if (rc != 0) {
    throw std::runtime_error(std::string("DNS lookup failed: ") +
                             gai_strerror(rc));
  }
  std::unique_ptr<addrinfo, decltype(&freeaddrinfo)> resolved(
      result, &freeaddrinfo);

  int raw = -1;
  for (addrinfo* it = resolved.get(); it != nullptr; it = it->ai_next) {
    raw = ::socket(it->ai_family, it->ai_socktype, it->ai_protocol);
    if (raw < 0) {
      continue;
    }
    if (::connect(raw, it->ai_addr, it->ai_addrlen) == 0) {
      break;
    }
    ::close(raw);
    raw = -1;
  }
  if (raw < 0) {
    throw std::runtime_error("could not connect to the SGLang server");
  }
  Socket socket(raw);
  cancel.arm(socket.get(), seen);
  struct Disarm {
    const CancelState& cancel;
    ~Disarm() { cancel.disarm(); }
  } disarm{cancel};

  std::string request = "POST " + path +
                        " HTTP/1.1\r\nHost: " + endpoint.host + ":" + port +
                        "\r\nContent-Type: application/json\r\nContent-Length: " +
                        std::to_string(body.size()) +
                        "\r\nConnection: close\r\n\r\n" + body;
  if (!sendAll(socket.get(), request)) {
    if (cancel.stopped(seen)) {
      return false;
    }
    throw std::runtime_error("HTTP send failed");
  }
  if (cancel.stopped(seen)) {
    return false;
  }

  std::string pending;
  auto readMore = [&]() -> bool {
    char buf[8192];
    const ssize_t n = ::recv(socket.get(), buf, sizeof(buf), 0);
    if (n < 0) {
      if (errno == EINTR) {
        return true;
      }
      return false;
    }
    if (n == 0) {
      return false;
    }
    pending.append(buf, static_cast<std::size_t>(n));
    return true;
  };

  std::size_t headerEnd = std::string::npos;
  while (headerEnd == std::string::npos) {
    headerEnd = pending.find("\r\n\r\n");
    if (headerEnd != std::string::npos) {
      break;
    }
    if (!readMore()) {
      if (cancel.stopped(seen)) {
        return false;
      }
      throw std::runtime_error("HTTP response ended before headers");
    }
  }
  const std::string headers = pending.substr(0, headerEnd);
  pending.erase(0, headerEnd + 4);
  const int status = statusCode(headers);

  std::string transfer;
  const bool chunked =
      headerValue(headers, "Transfer-Encoding", transfer) &&
      transfer.find("chunked") != std::string::npos;
  std::string lengthText;
  const bool hasLength = headerValue(headers, "Content-Length", lengthText);

  auto deliver = [&](std::string_view bytes) {
    if (status >= 200 && status < 300 && !bytes.empty()) {
      onBody(bytes);
    }
  };

  std::string errorBody;
  if (chunked) {
    ChunkedDecoder decoder;
    std::string decoded;
    auto consume = [&](std::string_view bytes) {
      if (status >= 400) {
        errorBody.append(bytes);
      } else {
        deliver(bytes);
      }
    };
    if (!pending.empty()) {
      decoded.clear();
      decoder.feed(pending, decoded);
      pending.clear();
      consume(decoded);
    }
    while (!decoder.finished()) {
      if (cancel.stopped(seen)) {
        return false;
      }
      if (!readMore()) {
        if (cancel.stopped(seen)) {
          return false;
        }
        throw std::runtime_error("truncated chunked HTTP body");
      }
      decoded.clear();
      decoder.feed(pending, decoded);
      pending.clear();
      consume(decoded);
    }
  } else if (hasLength) {
    const std::size_t length = std::stoul(lengthText);
    while (pending.size() < length) {
      if (cancel.stopped(seen)) {
        return false;
      }
      if (!readMore()) {
        if (cancel.stopped(seen)) {
          return false;
        }
        throw std::runtime_error("truncated HTTP body");
      }
    }
    if (status >= 400) {
      errorBody.assign(pending, 0, length);
    } else {
      deliver(std::string_view(pending).substr(0, length));
    }
  } else {
    while (readMore()) {
      if (cancel.stopped(seen)) {
        return false;
      }
    }
    if (status >= 400) {
      errorBody = std::move(pending);
    } else {
      deliver(pending);
    }
  }

  if (status < 200 || status >= 300) {
    throw std::runtime_error(httpErrorMessage(errorBody));
  }
  return !cancel.stopped(seen);
#endif
}

} // namespace qvac_llm_sglang
