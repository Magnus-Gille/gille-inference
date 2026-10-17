// Disposable hosted Linux fixture only; never a production launcher.
#include "../producer/endpoint.h"
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <grp.h>
#include <signal.h>
#include <stdexcept>
#include <sys/wait.h>
#include <unistd.h>

using namespace gille::producer;
namespace {
constexpr const char* directory = "/run/gille-producer-observer-gi-test-crossuid";
void require(bool okay, const char* message) { if (!okay) throw std::runtime_error(message); }
bool envIs(const char* key, const char* expected) {
    const char* value = std::getenv(key);
    return value && std::strcmp(value, expected) == 0;
}
Identity identity() {
    Identity id;
    std::strcpy(id.producerId.data(), "gi-test-crossuid");
    id.instanceSha256.fill('a'); id.instanceSha256[64] = 0;
    id.buildSha256.fill('b'); id.buildSha256[64] = 0;
    id.configSha256.fill('c'); id.configSha256[64] = 0;
    return id;
}
void probe(int executable, const char* mode) {
    char pid[32];
    std::snprintf(pid, sizeof pid, "%ld", static_cast<long>(getpid()));
    char name[] = "native-producer-probe", runtime[] = "runtime", path[] = "PATH=/usr/bin:/bin";
    char* arguments[] = {name, const_cast<char*>(mode), pid, runtime, nullptr};
    char* environment[] = {path, nullptr};
    pid_t child = fork();
    require(child >= 0, "fork failed");
    if (child == 0) {
        if (setgroups(0, nullptr) != 0 || setgid(65534) != 0 || setuid(65534) != 0) _exit(126);
        fexecve(executable, arguments, environment);
        _exit(127);
    }
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    int status = 0;
    while (std::chrono::steady_clock::now() < deadline) {
        pid_t result = waitpid(child, &status, WNOHANG);
        if (result == child) {
            require(WIFEXITED(status) && WEXITSTATUS(status) == 0, mode);
            return;
        }
        if (result < 0 && errno != EINTR) throw std::runtime_error("waitpid failed");
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    kill(child, SIGKILL);
    while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    throw std::runtime_error("probe deadline exceeded");
}
void cases(int executable) {
    {
        Activity activity;
        activity.begin(Stage::active); activity.begin(Stage::queued); activity.begin(Stage::loading);
        Endpoint endpoint(activity, identity(), 65534);
        require(endpoint.start(), "busy endpoint failed");
        probe(executable, "busy"); probe(executable, "invalid-id");
        probe(executable, "build"); probe(executable, "config"); probe(executable, "instance");
        probe(executable, "peer-pid"); probe(executable, "start");
        require(endpoint.close(), "busy cleanup failed");
    }
    {
        Activity activity;
        activity.finish(activity.begin(Stage::active));
        Endpoint endpoint(activity, identity(), 65534);
        require(endpoint.start(), "idle endpoint failed");
        probe(executable, "idle");
        activity.invalidate();
        probe(executable, "unknown");
        require(endpoint.close(), "idle cleanup failed");
    }
    {
        Activity activity;
        activity.finish(activity.begin(Stage::active));
        Endpoint endpoint(activity, identity(), 65533);
        require(endpoint.start(), "denied endpoint failed");
        probe(executable, "denied");
        require(activity.snapshot().known, "untrusted caller poisoned accounting");
        require(endpoint.close(), "denied cleanup failed");
    }
}
}
int main(int argc, char** argv) {
    if (argc != 2 || geteuid() != 0 || !envIs("GITHUB_ACTIONS", "true") ||
        !envIs("RUNNER_ENVIRONMENT", "github-hosted")) return 2;
    int executable = open(argv[1], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat binary{};
    if (executable < 0 || fstat(executable, &binary) != 0 || !S_ISREG(binary.st_mode) ||
        (binary.st_mode & 0111) == 0) { if (executable >= 0) close(executable); return 2; }
    if (mkdir(directory, 0755) != 0) { close(executable); return 2; }
    int result = 0;
    try { cases(executable); }
    catch (const std::exception& error) { std::fprintf(stderr, "runtime channel: %s\n", error.what()); result = 1; }
    if (rmdir(directory) != 0) { std::fputs("runtime fixture cleanup failed\n", stderr); result = 1; }
    close(executable);
    return result;
}
