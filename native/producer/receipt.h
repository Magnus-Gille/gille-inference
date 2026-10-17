#ifndef GILLE_PRODUCER_RECEIPT_H
#define GILLE_PRODUCER_RECEIPT_H

#include "activity.h"

#include <array>
#include <cstddef>

namespace gille::producer {

struct Identity {
    std::array<char, 65> producerId{};
    std::array<char, 65> instanceSha256{};
    std::array<char, 65> buildSha256{};
    std::array<char, 65> configSha256{};
};

struct Receipt {
    std::array<char, 2049> bytes{};
    std::size_t size = 0;
};

bool encodeReceipt(const Identity& identity, const Snapshot& snapshot,
                   const std::array<char, 65>& nonce, Receipt& out);

}  // namespace gille::producer

#endif
