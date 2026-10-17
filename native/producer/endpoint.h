#ifndef GILLE_PRODUCER_ENDPOINT_H
#define GILLE_PRODUCER_ENDPOINT_H
#include "receipt.h"
#include <atomic>
#include <thread>
#include <sys/stat.h>

namespace gille::producer {

enum class EndpointError { none, configuration, directory, socket, worker, cleanup };

// Linux-only, opt-in channel. Caller supplies verified immutable identities and
// keeps Activity alive until destruction. start/close must be serialized by the
// caller. One start attempt per object; close is idempotent. This is telemetry,
// not executable/configuration attestation or an admission decision.
class Endpoint final {
public:
    Endpoint(Activity& activity, const Identity& identity, std::uint32_t observerUid);
    ~Endpoint();
    Endpoint(const Endpoint&) = delete;
    Endpoint& operator=(const Endpoint&) = delete;
    bool start();
    bool close();
    EndpointError error() const { return error_.load(); }
private:
    void run();
    void serve(int client);
    void fail(EndpointError reason);
    bool pathMatches() const;
    Activity& activity_;
    const Identity identity_;
    const std::uint32_t observerUid_;
    std::array<char, 108> path_{};
    std::array<char, 96> directoryPath_{};
    int directory_ = -1, listener_ = -1;
    struct stat parent_{}, socket_{};
    bool attempted_ = false, ownsSocket_ = false;
    std::atomic<bool> stop_{false};
    std::atomic<EndpointError> error_{EndpointError::none};
    std::thread worker_;
};
}
#endif
