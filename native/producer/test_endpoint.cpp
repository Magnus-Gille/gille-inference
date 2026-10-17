#include "endpoint.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <cerrno>
#include <chrono>
#include <climits>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <string>
#include <thread>
#include <time.h>
#include <unistd.h>

#ifdef __linux__

extern "C" {
#include "../observer/producer_receipt.h"
}

#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>

namespace {

using gille::producer::Activity;
using gille::producer::Endpoint;
using gille::producer::EndpointError;
using gille::producer::Identity;
using gille::producer::Snapshot;
using gille::producer::Stage;
using gille::producer::Token;

constexpr int kClientDeadlineMs = 500;
constexpr std::size_t kRequestSize = 74;
constexpr std::size_t kReceiptLimit = 2048;

struct FileIdentity {
    dev_t device = 0;
    ino_t inode = 0;
    uid_t uid = 0;
    mode_t type = 0;
};

FileIdentity identityOf(const struct stat& value) {
    return FileIdentity{value.st_dev, value.st_ino, value.st_uid,
                        static_cast<mode_t>(value.st_mode & S_IFMT)};
}

bool sameIdentity(const FileIdentity& expected, const struct stat& actual) {
    return expected.device == actual.st_dev && expected.inode == actual.st_ino &&
           expected.uid == actual.st_uid && expected.type == (actual.st_mode & S_IFMT);
}

void require(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "test_endpoint: %s\n", message);
        std::abort();
    }
}

std::uint64_t monotonicMilliseconds() {
    struct timespec now{};
    require(clock_gettime(CLOCK_MONOTONIC, &now) == 0, "clock_gettime failed");
    require(now.tv_sec >= 0, "negative monotonic clock");
    return static_cast<std::uint64_t>(now.tv_sec) * 1000U +
           static_cast<std::uint64_t>(now.tv_nsec) / 1000000U;
}

int boundedRemaining(std::uint64_t deadline) {
    const std::uint64_t now = monotonicMilliseconds();
    if (now >= deadline) return 0;
    const std::uint64_t remaining = deadline - now;
    return remaining > static_cast<std::uint64_t>(INT32_MAX)
               ? INT32_MAX
               : static_cast<int>(remaining);
}

bool waitFor(int fd, short events, std::uint64_t deadline) {
    for (;;) {
        const int remaining = boundedRemaining(deadline);
        if (remaining <= 0) return false;
        struct pollfd descriptor{fd, events, 0};
        const int result = poll(&descriptor, 1, remaining);
        if (result < 0 && errno == EINTR) continue;
        if (result <= 0) return false;
        if ((descriptor.revents & (POLLERR | POLLNVAL)) != 0) return false;
        if ((descriptor.revents & (events | POLLHUP)) != 0) return true;
    }
}

int openClient(const std::string& path, std::uint64_t deadline) {
    const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    require(fd >= 0, "client socket creation failed");

    struct sockaddr_un address{};
    address.sun_family = AF_UNIX;
    require(path.size() < sizeof(address.sun_path), "socket path is too long");
    std::memcpy(address.sun_path, path.c_str(), path.size() + 1U);
    const socklen_t addressLength = static_cast<socklen_t>(
        offsetof(struct sockaddr_un, sun_path) + path.size() + 1U);
    if (connect(fd, reinterpret_cast<const struct sockaddr*>(&address), addressLength) == 0) {
        return fd;
    }
    require(errno == EINPROGRESS || errno == EINTR, "bounded client connect failed");
    require(waitFor(fd, POLLOUT, deadline), "bounded client connect timed out");

    int socketError = 0;
    socklen_t socketErrorLength = sizeof(socketError);
    require(getsockopt(fd, SOL_SOCKET, SO_ERROR, &socketError, &socketErrorLength) == 0,
            "client SO_ERROR read failed");
    require(socketError == 0, "client connect returned a socket error");
    return fd;
}

bool sendAll(int fd, const char* bytes, std::size_t size, std::uint64_t deadline) {
    std::size_t sent = 0;
    while (sent < size) {
        if (!waitFor(fd, POLLOUT, deadline)) return false;
        const ssize_t result = send(fd, bytes + sent, size - sent, MSG_NOSIGNAL);
        if (result < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
            continue;
        }
        if (result <= 0) return false;
        sent += static_cast<std::size_t>(result);
    }
    return true;
}

enum class ReadResult { eof, timeout, error };

ReadResult readToEof(int fd, std::string& output, std::uint64_t deadline) {
    std::array<char, 512> buffer{};
    output.clear();
    for (;;) {
        if (!waitFor(fd, POLLIN, deadline)) {
            return boundedRemaining(deadline) == 0 ? ReadResult::timeout : ReadResult::error;
        }
        const ssize_t result = recv(fd, buffer.data(), buffer.size(), 0);
        if (result < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
            continue;
        }
        if (result < 0) return ReadResult::error;
        if (result == 0) return ReadResult::eof;
        output.append(buffer.data(), static_cast<std::size_t>(result));
        require(output.size() <= kReceiptLimit, "receipt exceeded the native bound");
    }
}

std::string requestFor(const std::string& nonce) {
    require(nonce.size() == 64, "nonce must have 64 bytes");
    return "snapshot " + nonce + "\n";
}

void closeClient(int fd) {
    require(close(fd) == 0, "client close failed");
}

Identity identityFor(const std::string& producerId) {
    Identity identity{};
    require(producerId.size() < identity.producerId.size(), "producer ID is too long");
    std::copy(producerId.begin(), producerId.end(), identity.producerId.begin());
    const std::string instance(64, 'a');
    const std::string build(64, 'b');
    const std::string config(64, 'c');
    std::copy(instance.begin(), instance.end(), identity.instanceSha256.begin());
    std::copy(build.begin(), build.end(), identity.buildSha256.begin());
    std::copy(config.begin(), config.end(), identity.configSha256.begin());
    return identity;
}

std::string producerIdFor(unsigned int caseNumber) {
    return "gi-test-" + std::to_string(static_cast<unsigned long long>(getpid())) + "-" +
           std::to_string(caseNumber);
}

struct Fixture {
    std::string producerId;
    std::string directory;
    std::string socket;
    bool directoryOwned = false;
    FileIdentity directoryIdentity{};
    bool ownedSocket = false;
    FileIdentity socketIdentity{};

    explicit Fixture(unsigned int caseNumber)
        : producerId(producerIdFor(caseNumber)),
          directory("/run/gille-producer-observer-" + producerId),
          socket(directory + "/activity.sock") {
        struct stat existing{};
        require(lstat(directory.c_str(), &existing) != 0 && errno == ENOENT,
                "synthetic test directory already exists");
        require(mkdir(directory.c_str(), 0755) == 0, "synthetic directory creation failed");
        directoryOwned = true;
        struct stat created{};
        require(lstat(directory.c_str(), &created) == 0 && S_ISDIR(created.st_mode),
                "synthetic directory identity read failed");
        require(created.st_uid == geteuid() && (created.st_mode & 0777) == 0755,
                "synthetic directory ownership or mode is unsafe");
        directoryIdentity = identityOf(created);
    }

    ~Fixture() {
        if (ownedSocket) {
            struct stat current{};
            if (lstat(socket.c_str(), &current) == 0 && sameIdentity(socketIdentity, current)) {
                require(unlink(socket.c_str()) == 0, "owned socket fixture cleanup failed");
            }
            ownedSocket = false;
        }
        if (directoryOwned) {
            struct stat current{};
            if (lstat(directory.c_str(), &current) == 0) {
                if (sameIdentity(directoryIdentity, current)) {
                    require(S_ISDIR(current.st_mode) && current.st_uid == geteuid(),
                            "owned directory identity changed");
                    require(rmdir(directory.c_str()) == 0, "owned directory cleanup failed");
                } else {
                    require(false, "fixture directory was replaced");
                }
            }
            directoryOwned = false;
        }
    }

    void createRegularSocketPath() {
        const int fd = open(socket.c_str(), O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
        require(fd >= 0, "regular-file fixture creation failed");
        require(write(fd, "fixture", 7) == 7, "regular-file fixture write failed");
        require(close(fd) == 0, "regular-file fixture close failed");
        struct stat created{};
        require(lstat(socket.c_str(), &created) == 0 && S_ISREG(created.st_mode),
                "regular-file fixture identity failed");
        ownedSocket = true;
        socketIdentity = identityOf(created);
    }
};

struct SymlinkFixture {
    std::string producerId;
    std::string directory;
    std::string target;
    bool directoryOwned = false;
    bool targetOwned = false;
    FileIdentity directoryIdentity{};
    FileIdentity targetIdentity{};

    explicit SymlinkFixture(unsigned int caseNumber)
        : producerId(producerIdFor(caseNumber)),
          directory("/run/gille-producer-observer-" + producerId),
          target(directory + "-target") {
        struct stat existing{};
        require(lstat(directory.c_str(), &existing) != 0 && errno == ENOENT,
                "symlink test directory already exists");
        require(lstat(target.c_str(), &existing) != 0 && errno == ENOENT,
                "symlink test target already exists");
        require(mkdir(target.c_str(), 0755) == 0, "symlink target creation failed");
        targetOwned = true;
        struct stat targetInfo{};
        require(lstat(target.c_str(), &targetInfo) == 0 && S_ISDIR(targetInfo.st_mode) &&
                    targetInfo.st_uid == geteuid() && (targetInfo.st_mode & 0777) == 0755,
                "symlink target identity is unsafe");
        targetIdentity = identityOf(targetInfo);
        require(symlink(target.c_str(), directory.c_str()) == 0, "parent symlink creation failed");
        directoryOwned = true;
        struct stat symlinkInfo{};
        require(lstat(directory.c_str(), &symlinkInfo) == 0 && S_ISLNK(symlinkInfo.st_mode) &&
                    symlinkInfo.st_uid == geteuid(),
                "parent symlink identity is unsafe");
        directoryIdentity = identityOf(symlinkInfo);
    }

    ~SymlinkFixture() {
        if (directoryOwned) {
            struct stat current{};
            if (lstat(directory.c_str(), &current) == 0) {
                if (sameIdentity(directoryIdentity, current)) {
                    require(S_ISLNK(current.st_mode) && current.st_uid == geteuid(),
                            "parent symlink identity changed");
                    require(unlink(directory.c_str()) == 0, "parent symlink cleanup failed");
                } else {
                    require(false, "symlink fixture was replaced");
                }
            }
            directoryOwned = false;
        }
        if (targetOwned) {
            struct stat current{};
            if (lstat(target.c_str(), &current) == 0) {
                if (sameIdentity(targetIdentity, current)) {
                    require(S_ISDIR(current.st_mode) && current.st_uid == geteuid(),
                            "symlink target identity changed");
                    require(rmdir(target.c_str()) == 0, "symlink target cleanup failed");
                } else {
                    require(false, "symlink target was replaced");
                }
            }
            targetOwned = false;
        }
    }
};

void assertReceipt(const std::string& response, const Identity& identity,
                   const std::string& nonce, const Snapshot& expected) {
    require(!response.empty(), "endpoint returned no receipt");
    require(response.size() <= kReceiptLimit, "receipt exceeded the bound");
    struct gi_producer_receipt receipt{};
    require(gi_parse_producer_receipt(response.data(), response.size(), &receipt) == 0,
            "endpoint returned malformed JSON receipt");
    require(receipt.known == expected.known, "receipt known flag mismatch");
    require(std::strcmp(receipt.producer_id, identity.producerId.data()) == 0,
            "receipt producer ID mismatch");
    require(std::strcmp(receipt.instance_sha256, identity.instanceSha256.data()) == 0,
            "receipt instance digest mismatch");
    require(std::strcmp(receipt.build_sha256, identity.buildSha256.data()) == 0,
            "receipt build digest mismatch");
    require(std::strcmp(receipt.config_sha256, identity.configSha256.data()) == 0,
            "receipt config digest mismatch");
    require(std::strcmp(receipt.request_nonce_sha256, nonce.c_str()) == 0,
            "receipt nonce mismatch");
    require(receipt.active == expected.active && receipt.queued == expected.queued &&
                receipt.loading == expected.loading && receipt.work_started == expected.workStarted,
            "receipt counters mismatch");
}

void canonicalNonceAndCounters() {
    Fixture fixture(1);
    const Identity identity = identityFor(fixture.producerId);
    Activity activity;
    const Token active = activity.begin(Stage::active);
    const Token queued = activity.begin(Stage::queued);
    const Token loading = activity.begin(Stage::loading);
    require(active && queued && loading, "activity setup failed");
    Endpoint endpoint(activity, identity, static_cast<std::uint32_t>(geteuid()));
    require(endpoint.start(), "canonical endpoint start failed");

    const std::string nonce(64, 'd');
    const std::string request = requestFor(nonce);
    require(request.size() == kRequestSize, "canonical request is not 74 bytes");
    const std::uint64_t deadline = monotonicMilliseconds() + kClientDeadlineMs;
    const int client = openClient(fixture.socket, deadline);
    require(sendAll(client, request.data(), request.size(), deadline), "canonical request send failed");
    std::string response;
    require(readToEof(client, response, deadline) == ReadResult::eof,
            "canonical response did not terminate");
    closeClient(client);

    assertReceipt(response, identity, nonce, Snapshot{true, 1, 1, 1, 3});
    require(endpoint.close(), "canonical endpoint close failed");
    require(endpoint.close(), "endpoint close was not idempotent");
    require(!endpoint.start(), "endpoint accepted a second start");
    require(!activity.snapshot().known, "close did not invalidate activity");
    require(!activity.finish(active), "invalidated activity accepted a token");
    struct stat socketPath{};
    require(lstat(fixture.socket.c_str(), &socketPath) != 0 && errno == ENOENT,
            "owned socket was not removed");
}

void unknownSnapshot() {
    Fixture fixture(2);
    const Identity identity = identityFor(fixture.producerId);
    Activity activity;
    activity.invalidate();
    Endpoint endpoint(activity, identity, static_cast<std::uint32_t>(geteuid()));
    require(endpoint.start(), "unknown endpoint start failed");
    const std::string nonce(64, 'e');
    const std::uint64_t deadline = monotonicMilliseconds() + kClientDeadlineMs;
    const int client = openClient(fixture.socket, deadline);
    const std::string request = requestFor(nonce);
    require(sendAll(client, request.data(), request.size(), deadline), "unknown request send failed");
    std::string response;
    require(readToEof(client, response, deadline) == ReadResult::eof,
            "unknown response did not terminate");
    closeClient(client);
    assertReceipt(response, identity, nonce, Snapshot{false, 0, 0, 0, 0});
    require(endpoint.close(), "unknown endpoint close failed");
}

void malformedNonce() {
    Fixture fixture(3);
    const Identity identity = identityFor(fixture.producerId);
    Activity activity;
    Endpoint endpoint(activity, identity, static_cast<std::uint32_t>(geteuid()));
    require(endpoint.start(), "malformed-nonce endpoint start failed");
    std::string nonce(64, 'f');
    nonce[63] = 'G';
    const std::string request = requestFor(nonce);
    const std::uint64_t deadline = monotonicMilliseconds() + kClientDeadlineMs;
    const int client = openClient(fixture.socket, deadline);
    require(sendAll(client, request.data(), request.size(), deadline),
            "malformed-nonce request send failed");
    std::string response;
    const ReadResult result = readToEof(client, response, deadline);
    closeClient(client);
    require(response.empty() && (result == ReadResult::eof || result == ReadResult::error),
            "malformed nonce produced a receipt");
    require(activity.snapshot().known, "malformed nonce invalidated activity");
    require(endpoint.close(), "malformed-nonce endpoint close failed");
}

void wrongPeerUid() {
    Fixture fixture(4);
    const Identity identity = identityFor(fixture.producerId);
    Activity activity;
    Endpoint endpoint(activity, identity, static_cast<std::uint32_t>(geteuid()) + 1U);
    require(endpoint.start(), "wrong-UID endpoint start failed");
    const std::string nonce(64, '1');
    const std::string request = requestFor(nonce);
    const std::uint64_t deadline = monotonicMilliseconds() + kClientDeadlineMs;
    const int client = openClient(fixture.socket, deadline);
    (void)sendAll(client, request.data(), request.size(), deadline);
    std::string response;
    const ReadResult result = readToEof(client, response, deadline);
    closeClient(client);
    require(response.empty() && (result == ReadResult::eof || result == ReadResult::error),
            "wrong peer UID reached the receipt path");
    require(activity.snapshot().known, "wrong peer UID invalidated activity");
    require(endpoint.close(), "wrong-UID endpoint close failed");
}

void slowClientDeadline() {
    Fixture fixture(5);
    const Identity identity = identityFor(fixture.producerId);
    Activity activity;
    const Token active = activity.begin(Stage::active);
    require(static_cast<bool>(active), "slow-client activity setup failed");
    Endpoint endpoint(activity, identity, static_cast<std::uint32_t>(geteuid()));
    require(endpoint.start(), "slow-client endpoint start failed");
    const std::string nonce(64, '2');
    const std::string request = requestFor(nonce);
    const std::uint64_t connectDeadline = monotonicMilliseconds() + kClientDeadlineMs;
    const int client = openClient(fixture.socket, connectDeadline);
    const std::uint64_t started = monotonicMilliseconds();
    require(sendAll(client, request.data(), 1, started + kClientDeadlineMs),
            "slow-client prefix send failed");
    std::string response;
    const ReadResult result = readToEof(client, response, started + 1200);
    const std::uint64_t elapsed = monotonicMilliseconds() - started;
    closeClient(client);
    require(response.empty() && result == ReadResult::eof,
            "slow client did not receive a bounded EOF");
    require(elapsed >= 300 && elapsed <= 1200, "slow client deadline was not exercised");
    require(activity.snapshot().known, "slow client invalidated activity");

    const std::string validNonce(64, '3');
    const std::string validRequest = requestFor(validNonce);
    const std::uint64_t recoveryDeadline = monotonicMilliseconds() + kClientDeadlineMs;
    const int recoveryClient = openClient(fixture.socket, recoveryDeadline);
    require(sendAll(recoveryClient, validRequest.data(), validRequest.size(), recoveryDeadline),
            "post-timeout recovery request send failed");
    std::string recoveryResponse;
    require(readToEof(recoveryClient, recoveryResponse, recoveryDeadline) == ReadResult::eof,
            "endpoint worker did not recover after slow client");
    closeClient(recoveryClient);
    assertReceipt(recoveryResponse, identity, validNonce, Snapshot{true, 1, 0, 0, 1});
    require(endpoint.close(), "slow-client endpoint close failed");
}

void preexistingRegularFile() {
    Fixture fixture(6);
    fixture.createRegularSocketPath();
    const Identity identity = identityFor(fixture.producerId);
    Activity activity;
    Endpoint endpoint(activity, identity, static_cast<std::uint32_t>(geteuid()));
    require(!endpoint.start() && endpoint.error() == EndpointError::socket,
            "regular socket path was not refused");
    struct stat preserved{};
    require(lstat(fixture.socket.c_str(), &preserved) == 0 &&
                sameIdentity(fixture.socketIdentity, preserved) && S_ISREG(preserved.st_mode),
            "preexisting regular file was changed");
    require(!endpoint.close(), "failed endpoint close unexpectedly succeeded");
    require(endpoint.error() == EndpointError::socket,
            "regular-file refusal error was not preserved");
}

void unsafeParentMode() {
    Fixture fixture(7);
    require(chmod(fixture.directory.c_str(), 0777) == 0, "unsafe parent chmod failed");
    const Identity identity = identityFor(fixture.producerId);
    Activity activity;
    Endpoint endpoint(activity, identity, static_cast<std::uint32_t>(geteuid()));
    require(!endpoint.start() && endpoint.error() == EndpointError::directory,
            "group/world-writable parent was not refused");
    struct stat parent{};
    require(lstat(fixture.directory.c_str(), &parent) == 0 && S_ISDIR(parent.st_mode) &&
                (parent.st_mode & 0777) == 0777,
            "unsafe parent was changed");
}

void symlinkParent() {
    SymlinkFixture fixture(8);
    const Identity identity = identityFor(fixture.producerId);
    Activity activity;
    Endpoint endpoint(activity, identity, static_cast<std::uint32_t>(geteuid()));
    require(!endpoint.start() && endpoint.error() == EndpointError::directory,
            "symlink parent was not refused");
    struct stat parent{};
    struct stat target{};
    require(lstat(fixture.directory.c_str(), &parent) == 0 && S_ISLNK(parent.st_mode),
            "parent symlink was changed");
    require(lstat(fixture.target.c_str(), &target) == 0 && S_ISDIR(target.st_mode),
            "symlink target was changed");
}

void cleanupAndReplacementIdentity() {
    Fixture fixture(9);
    const Identity identity = identityFor(fixture.producerId);
    Activity activity;
    const Token token = activity.begin(Stage::active);
    require(static_cast<bool>(token), "replacement cleanup activity setup failed");
    Endpoint endpoint(activity, identity, static_cast<std::uint32_t>(geteuid()));
    require(endpoint.start(), "replacement cleanup endpoint start failed");
    struct stat original{};
    require(lstat(fixture.socket.c_str(), &original) == 0 && S_ISSOCK(original.st_mode),
            "owned endpoint socket identity read failed");
    require(unlink(fixture.socket.c_str()) == 0, "owned endpoint socket unlink failed");
    const int replacementFd = open(fixture.socket.c_str(), O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
    require(replacementFd >= 0, "replacement regular file creation failed");
    require(write(replacementFd, "replacement", 11) == 11, "replacement file write failed");
    require(close(replacementFd) == 0, "replacement file close failed");
    struct stat replacement{};
    require(lstat(fixture.socket.c_str(), &replacement) == 0 && S_ISREG(replacement.st_mode),
            "replacement regular file identity read failed");
    fixture.ownedSocket = true;
    fixture.socketIdentity = identityOf(replacement);

    require(!endpoint.close() && endpoint.error() == EndpointError::cleanup,
            "replaced socket path did not report cleanup failure");
    require(!activity.snapshot().known, "replacement cleanup did not invalidate activity");
    struct stat preserved{};
    require(lstat(fixture.socket.c_str(), &preserved) == 0 &&
                sameIdentity(fixture.socketIdentity, preserved) && S_ISREG(preserved.st_mode),
            "replacement regular file was unlinked");
    require(!endpoint.close(), "replacement cleanup close was not idempotent");
}

}  // namespace

int main() {
    const char* githubActions = std::getenv("GITHUB_ACTIONS");
    const char* runnerEnvironment = std::getenv("RUNNER_ENVIRONMENT");
    if (githubActions == nullptr || std::strcmp(githubActions, "true") != 0 ||
        runnerEnvironment == nullptr || std::strcmp(runnerEnvironment, "github-hosted") != 0 ||
        geteuid() != 0) {
        std::fprintf(stderr, "test_endpoint: refused; fresh GitHub-hosted root fixture required\n");
        return 2;
    }

    canonicalNonceAndCounters();
    unknownSnapshot();
    malformedNonce();
    wrongPeerUid();
    slowClientDeadline();
    preexistingRegularFile();
    unsafeParentMode();
    symlinkParent();
    cleanupAndReplacementIdentity();
    return 0;
}

#else

int main() {
    // The runtime channel is intentionally Linux-only: macOS has no SO_PEERCRED.
    std::fprintf(stderr, "test_endpoint: refused; Linux runtime channel required\n");
    return 2;
}

#endif
