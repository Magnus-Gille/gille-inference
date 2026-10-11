#include "receipt.h"

#include <charconv>
#include <cstdint>
#include <system_error>

namespace gille::producer {

namespace {

constexpr std::uint64_t kSafeIntegerMax = 9007199254740991ULL;

bool isProducerIdChar(unsigned char value) {
    return (value >= static_cast<unsigned char>('A') &&
            value <= static_cast<unsigned char>('Z')) ||
           (value >= static_cast<unsigned char>('a') &&
            value <= static_cast<unsigned char>('z')) ||
           (value >= static_cast<unsigned char>('0') &&
            value <= static_cast<unsigned char>('9')) ||
           value == static_cast<unsigned char>('_') ||
           value == static_cast<unsigned char>('-');
}

bool isLowerHex(unsigned char value) {
    return (value >= static_cast<unsigned char>('0') &&
            value <= static_cast<unsigned char>('9')) ||
           (value >= static_cast<unsigned char>('a') &&
            value <= static_cast<unsigned char>('f'));
}

bool validProducerId(const std::array<char, 65>& value, std::size_t& length) {
    length = 0;
    while (length < value.size() && value[length] != '\0') ++length;
    if (length == 0 || length == value.size() || length > 64) return false;
    for (std::size_t index = 0; index < length; ++index) {
        if (!isProducerIdChar(static_cast<unsigned char>(value[index]))) return false;
    }
    for (std::size_t index = length; index < value.size(); ++index) {
        if (value[index] != '\0') return false;
    }
    return true;
}

bool validHash(const std::array<char, 65>& value) {
    if (value[64] != '\0') return false;
    for (std::size_t index = 0; index < 64; ++index) {
        if (!isLowerHex(static_cast<unsigned char>(value[index]))) return false;
    }
    return true;
}

bool validSnapshot(const Snapshot& snapshot) {
    if (snapshot.active > kSafeIntegerMax || snapshot.queued > kSafeIntegerMax ||
        snapshot.loading > kSafeIntegerMax ||
        snapshot.workStarted > kSafeIntegerMax) {
        return false;
    }
    std::uint64_t sum = snapshot.active;
    if (snapshot.queued > kSafeIntegerMax - sum) return false;
    sum += snapshot.queued;
    if (snapshot.loading > kSafeIntegerMax - sum) return false;
    sum += snapshot.loading;
    return sum <= snapshot.workStarted;
}

class Writer final {
public:
    explicit Writer(Receipt& receipt) : receipt_(receipt) {}

    template <std::size_t N>
    bool literal(const char (&value)[N]) {
        return append(value, N - 1);
    }

    bool append(const char* value, std::size_t length) {
        if (length > receipt_.bytes.size() - position_) return false;
        for (std::size_t index = 0; index < length; ++index) {
            receipt_.bytes[position_ + index] = value[index];
        }
        position_ += length;
        return true;
    }

    bool number(std::uint64_t value) {
        if (position_ >= receipt_.bytes.size()) return false;
        const auto result = std::to_chars(receipt_.bytes.data() + position_,
                                          receipt_.bytes.data() + receipt_.bytes.size(),
                                          value);
        if (result.ec != std::errc{}) return false;
        position_ = static_cast<std::size_t>(result.ptr - receipt_.bytes.data());
        return true;
    }

    bool finish() {
        if (position_ >= receipt_.bytes.size()) return false;
        receipt_.bytes[position_] = '\0';
        receipt_.size = position_;
        return true;
    }

private:
    Receipt& receipt_;
    std::size_t position_ = 0;
};

void clear(Receipt& receipt) {
    receipt.bytes.fill('\0');
    receipt.size = 0;
}

}  // namespace

bool encodeReceipt(const Identity& identity, const Snapshot& snapshot,
                   const std::array<char, 65>& nonce, Receipt& out) {
    clear(out);

    std::size_t producerIdLength = 0;
    if (!validProducerId(identity.producerId, producerIdLength) ||
        !validHash(identity.instanceSha256) || !validHash(identity.buildSha256) ||
        !validHash(identity.configSha256) || !validHash(nonce) ||
        (snapshot.known && !validSnapshot(snapshot))) {
        return false;
    }

    Writer writer(out);
    bool okay = writer.literal("{\"schemaVersion\":1,\"producerId\":\"") &&
                writer.append(identity.producerId.data(), producerIdLength) &&
                writer.literal("\",\"instanceSha256\":\"") &&
                writer.append(identity.instanceSha256.data(), 64) &&
                writer.literal("\",\"buildSha256\":\"") &&
                writer.append(identity.buildSha256.data(), 64) &&
                writer.literal("\",\"configSha256\":\"") &&
                writer.append(identity.configSha256.data(), 64) &&
                writer.literal("\",\"requestNonceSha256\":\"") &&
                writer.append(nonce.data(), 64) &&
                writer.literal("\",");
    if (okay && snapshot.known) {
        okay = writer.literal("\"active\":") && writer.number(snapshot.active) &&
                writer.literal(",\"queued\":") && writer.number(snapshot.queued) &&
                writer.literal(",\"loading\":") && writer.number(snapshot.loading) &&
                writer.literal(",\"workStarted\":") && writer.number(snapshot.workStarted);
    } else if (okay) {
        okay = writer.literal("\"active\":null,\"queued\":null,\"loading\":null,"
                             "\"workStarted\":null");
    }
    okay = okay && writer.literal("}\n") && writer.finish();
    if (!okay) clear(out);
    return okay;
}

}  // namespace gille::producer
