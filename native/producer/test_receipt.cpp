#include "receipt.h"

extern "C" {
#include "../observer/producer_receipt.h"
}

#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>

namespace {

using gille::producer::Identity;
using gille::producer::Receipt;
using gille::producer::Snapshot;

std::array<char, 65> hash(char value = 'a') {
    std::array<char, 65> result{};
    result.fill(value);
    result[64] = '\0';
    return result;
}

Identity identity() {
    Identity result;
    result.producerId[0] = 'p';
    result.producerId[1] = 'r';
    result.producerId[2] = 'o';
    result.producerId[3] = 'd';
    result.producerId[4] = '_';
    result.producerId[5] = '1';
    result.instanceSha256 = hash('0');
    result.buildSha256 = hash('1');
    result.configSha256 = hash('2');
    return result;
}

Snapshot busy() { return Snapshot{true, 2, 3, 4, 10}; }

std::string output(const Receipt& receipt) {
    return std::string(receipt.bytes.data(), receipt.size);
}

void assertParsed(const Receipt& receipt, bool known, std::uint64_t active,
                  std::uint64_t queued, std::uint64_t loading,
                  std::uint64_t workStarted) {
    gi_producer_receipt parsed{};
    assert(gi_parse_producer_receipt(receipt.bytes.data(), receipt.size, &parsed) == 0);
    assert(parsed.known == known);
    assert(parsed.active == active);
    assert(parsed.queued == queued);
    assert(parsed.loading == loading);
    assert(parsed.work_started == workStarted);
}

void assertCleared(const Receipt& receipt) {
    assert(receipt.size == 0);
    for (char byte : receipt.bytes) assert(byte == '\0');
}

void testKnownAndUnknown() {
    const Identity id = identity();
    const auto nonce = hash('3');
    Receipt receipt;
    assert(gille::producer::encodeReceipt(id, busy(), nonce, receipt));
    assert(output(receipt) ==
           "{\"schemaVersion\":1,\"producerId\":\"prod_1\","
           "\"instanceSha256\":\"" + std::string(64, '0') +
           "\",\"buildSha256\":\"" + std::string(64, '1') +
           "\",\"configSha256\":\"" + std::string(64, '2') +
           "\",\"requestNonceSha256\":\"" + std::string(64, '3') +
           "\",\"active\":2,\"queued\":3,\"loading\":4,"
           "\"workStarted\":10}\n");
    assert(receipt.bytes[receipt.size] == '\0');
    assertParsed(receipt, true, 2, 3, 4, 10);

    Snapshot idle{true, 0, 0, 0, 0};
    assert(gille::producer::encodeReceipt(id, idle, nonce, receipt));
    assert(output(receipt).find("\"active\":0,\"queued\":0,\"loading\":0,\"workStarted\":0") !=
           std::string::npos);
    assertParsed(receipt, true, 0, 0, 0, 0);

    Snapshot unknown{false, UINT64_MAX, UINT64_MAX, UINT64_MAX, UINT64_MAX};
    assert(gille::producer::encodeReceipt(id, unknown, nonce, receipt));
    assert(output(receipt).find("\"active\":null,\"queued\":null,\"loading\":null,\"workStarted\":null") !=
           std::string::npos);
    assertParsed(receipt, false, 0, 0, 0, 0);
}

void testMaximumsAndInvalidCounts() {
    const Identity id = identity();
    const auto nonce = hash();
    Receipt receipt;
    constexpr std::uint64_t safe = 9007199254740991ULL;
    Snapshot maximum{true, safe, 0, 0, safe};
    assert(gille::producer::encodeReceipt(id, maximum, nonce, receipt));
    assert(output(receipt).find("\"active\":9007199254740991") != std::string::npos);
    assertParsed(receipt, true, safe, 0, 0, safe);

    const Snapshot tooLarge{true, safe + 1, 0, 0, safe + 1};
    assert(!gille::producer::encodeReceipt(id, tooLarge, nonce, receipt));
    assertCleared(receipt);
    const Snapshot sumTooLarge{true, safe, 1, 0, safe};
    assert(!gille::producer::encodeReceipt(id, sumTooLarge, nonce, receipt));
    assertCleared(receipt);
    const Snapshot sumExceedsStarted{true, 2, 3, 4, 8};
    assert(!gille::producer::encodeReceipt(id, sumExceedsStarted, nonce, receipt));
    assertCleared(receipt);
    const Snapshot uintOverflow{true, UINT64_MAX, 0, 0, UINT64_MAX};
    assert(!gille::producer::encodeReceipt(id, uintOverflow, nonce, receipt));
    assertCleared(receipt);
}

void testCanonicalInputs() {
    const auto nonce = hash();
    Receipt receipt;
    Identity id = identity();
    assert(gille::producer::encodeReceipt(id, busy(), nonce, receipt));
    Identity maximumId = id;
    maximumId.producerId.fill('Z');
    maximumId.producerId[64] = '\0';
    assert(gille::producer::encodeReceipt(maximumId, busy(), nonce, receipt));
    assert(output(receipt).find("\"producerId\":\"" + std::string(64, 'Z') + "\"") !=
           std::string::npos);
    auto expectInvalid = [&](Identity invalidId, const std::array<char, 65>& invalidNonce) {
        receipt.bytes.fill('x');
        receipt.size = 7;
        assert(!gille::producer::encodeReceipt(invalidId, busy(), invalidNonce, receipt));
        assertCleared(receipt);
    };

    Identity empty = id;
    empty.producerId[0] = '\0';
    expectInvalid(empty, nonce);
    Identity unterminated = id;
    unterminated.producerId.fill('a');
    expectInvalid(unterminated, nonce);
    Identity trailing = id;
    trailing.producerId[7] = 'x';
    expectInvalid(trailing, nonce);
    Identity injection = id;
    injection.producerId[0] = '"';
    expectInvalid(injection, nonce);
    Identity control = id;
    control.producerId[0] = '\n';
    expectInvalid(control, nonce);

    auto uppercase = nonce;
    uppercase[0] = 'A';
    expectInvalid(id, uppercase);
    auto badNonce = nonce;
    badNonce[64] = 'x';
    expectInvalid(id, badNonce);
    Identity badHash = id;
    badHash.configSha256[63] = 'G';
    expectInvalid(badHash, nonce);
    Identity badHashTerminator = id;
    badHashTerminator.instanceSha256[64] = 'x';
    expectInvalid(badHashTerminator, nonce);
}

}  // namespace

int main() {
    testKnownAndUnknown();
    testMaximumsAndInvalidCounts();
    testCanonicalInputs();
    return 0;
}
