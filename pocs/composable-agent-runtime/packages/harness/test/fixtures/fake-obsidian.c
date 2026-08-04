#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static const char *value_for(int argc, char **argv, const char *key) {
  size_t key_length = strlen(key);
  for (int index = 1; index < argc; index++) {
    if (strncmp(argv[index], key, key_length) == 0 &&
        argv[index][key_length] == '=') {
      return argv[index] + key_length + 1;
    }
  }
  return NULL;
}

static int direct_egress_denied(void) {
  int descriptor = socket(AF_INET, SOCK_STREAM, 0);
  if (descriptor < 0) return 0;
  int flags = fcntl(descriptor, F_GETFL, 0);
  if (flags >= 0) fcntl(descriptor, F_SETFL, flags | O_NONBLOCK);

  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(9);
  inet_pton(AF_INET, "198.51.100.1", &address.sin_addr);

  int result = connect(
      descriptor, (const struct sockaddr *)&address, sizeof(address));
  int error = errno;
  close(descriptor);
  return result < 0 && (error == EPERM || error == EACCES);
}

static int loopback_denied(const char *query) {
  const char *prefix = "loopback:";
  size_t prefix_length = strlen(prefix);
  if (strncmp(query, prefix, prefix_length) != 0) return 0;
  long port = strtol(query + prefix_length, NULL, 10);
  if (port < 1 || port > 65535) return 0;

  int descriptor = socket(AF_INET, SOCK_STREAM, 0);
  if (descriptor < 0) return 0;
  int flags = fcntl(descriptor, F_GETFL, 0);
  if (flags >= 0) fcntl(descriptor, F_SETFL, flags | O_NONBLOCK);

  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);

  int result = connect(
      descriptor, (const struct sockaddr *)&address, sizeof(address));
  int error = errno;
  close(descriptor);
  return result < 0 && (error == EPERM || error == EACCES);
}

static int read_note(int argc, char **argv) {
  const char *note_path = value_for(argc, argv, "path");
  if (note_path == NULL) {
    fputs("missing path\n", stderr);
    return 2;
  }
  FILE *file = fopen(note_path, "rb");
  if (file == NULL) {
    if (errno == EPERM || errno == EACCES) {
      fputs("vault boundary denied\n", stderr);
      return 13;
    }
    perror("read");
    return 1;
  }
  char buffer[256];
  size_t count;
  while ((count = fread(buffer, 1, sizeof(buffer), file)) > 0) {
    fwrite(buffer, 1, count, stdout);
  }
  fclose(file);
  return 0;
}

static int create_note(int argc, char **argv) {
  const char *note_path = value_for(argc, argv, "path");
  const char *content = value_for(argc, argv, "content");
  if (note_path == NULL || content == NULL) {
    fputs("missing path or content\n", stderr);
    return 2;
  }
  FILE *file = fopen(note_path, "wb");
  if (file == NULL) {
    perror("create");
    return 1;
  }
  fwrite(content, 1, strlen(content), file);
  fclose(file);
  printf("%s\n", note_path);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3 || strncmp(argv[1], "vault=", 6) != 0) {
    fputs("missing operation\n", stderr);
    return 2;
  }
  const char *vault = value_for(argc, argv, "vault");
  if (vault == NULL || strcmp(vault, "SyntheticVault") != 0) {
    fputs("trusted vault identity missing\n", stderr);
    return 5;
  }
  const char *operation = argv[2];
  if (strcmp(operation, "files") == 0) {
    if (!direct_egress_denied()) {
      fputs("direct external egress was not denied\n", stderr);
      return 3;
    }
    printf("%s direct-egress-denied\n", vault);
    return 0;
  }
  if (strcmp(operation, "read") == 0) return read_note(argc, argv);
  if (strcmp(operation, "create") == 0) return create_note(argc, argv);
  if (strcmp(operation, "search") == 0) {
    const char *query = value_for(argc, argv, "query");
    if (query != NULL && strcmp(query, "hang") == 0) {
      sleep(600);
      return 0;
    }
    if (query != NULL && strncmp(query, "loopback:", 9) == 0) {
      if (!loopback_denied(query)) {
        fputs("alternate loopback was not denied\n", stderr);
        return 4;
      }
      puts("alternate-loopback-denied");
      return 0;
    }
  }
  fputs("unsupported fake operation\n", stderr);
  return 2;
}
