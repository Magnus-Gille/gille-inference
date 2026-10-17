#include "unit_identity.h"

#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static sd_bus *test_bus;
static int peer_fd;

/* A private socket pair supplies an AUTHENTICATING bus. No daemon, system bus,
 * service mutation or received message is involved. */
static void start_test_bus(void)
{
    int sockets[2];

    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    assert(sd_bus_new(&test_bus) >= 0);
    assert(sd_bus_set_fd(test_bus, sockets[0], sockets[0]) >= 0);
    assert(sd_bus_start(test_bus) >= 0);
    peer_fd = sockets[1];
}

static sd_bus_message *new_message(void)
{
    sd_bus_message *call = NULL;
    sd_bus_message *message = NULL;

    assert(sd_bus_message_new_method_call(test_bus, &call,
        "org.example.Fixture", "/fixture", "org.example.Fixture", "Get") >= 0);
    assert(sd_bus_message_seal(call, 1, 0) >= 0);
    assert(sd_bus_message_new_method_return(call, &message) >= 0);
    sd_bus_message_unref(call);
    return message;
}

static void finish_message(sd_bus_message *message)
{
    assert(sd_bus_message_seal(message, 2, 0) >= 0);
    assert(sd_bus_message_rewind(message, 1) >= 0);
}

static void assert_zero_bytes(const void *bytes, size_t size)
{
    const unsigned char *value = bytes;
    size_t index;

    for (index = 0U; index < size; ++index) {
        assert(value[index] == 0U);
    }
}

static sd_bus_message *variant_bytes(const uint8_t *bytes, size_t size)
{
    sd_bus_message *message = new_message();

    assert(sd_bus_message_open_container(message, SD_BUS_TYPE_VARIANT, "ay") >= 0);
    assert(sd_bus_message_append_array(message, SD_BUS_TYPE_BYTE, bytes, size) >= 0);
    assert(sd_bus_message_close_container(message) >= 0);
    finish_message(message);
    return message;
}

static sd_bus_message *variant_uint(uint32_t value)
{
    sd_bus_message *message = new_message();

    assert(sd_bus_message_open_container(message, SD_BUS_TYPE_VARIANT, "u") >= 0);
    assert(sd_bus_message_append(message, "u", value) >= 0);
    assert(sd_bus_message_close_container(message) >= 0);
    finish_message(message);
    return message;
}

static sd_bus_message *variant_string(const char *value)
{
    sd_bus_message *message = new_message();

    assert(sd_bus_message_open_container(message, SD_BUS_TYPE_VARIANT, "s") >= 0);
    assert(sd_bus_message_append(message, "s", value) >= 0);
    assert(sd_bus_message_close_container(message) >= 0);
    finish_message(message);
    return message;
}

static sd_bus_message *wrong_top_type(void)
{
    sd_bus_message *message = new_message();

    assert(sd_bus_message_append(message, "u", 7U) >= 0);
    finish_message(message);
    return message;
}

static sd_bus_message *wrong_inner_type(void)
{
    sd_bus_message *message = new_message();

    assert(sd_bus_message_open_container(message, SD_BUS_TYPE_VARIANT, "s") >= 0);
    assert(sd_bus_message_append(message, "s", "wrong") >= 0);
    assert(sd_bus_message_close_container(message) >= 0);
    finish_message(message);
    return message;
}

static sd_bus_message *empty_reply(void)
{
    sd_bus_message *message = new_message();

    finish_message(message);
    return message;
}

static sd_bus_message *trailing_top_value(void)
{
    sd_bus_message *message = new_message();

    assert(sd_bus_message_open_container(message, SD_BUS_TYPE_VARIANT, "u") >= 0);
    assert(sd_bus_message_append(message, "u", 7U) >= 0);
    assert(sd_bus_message_close_container(message) >= 0);
    assert(sd_bus_message_append(message, "u", 8U) >= 0);
    finish_message(message);
    return message;
}

static void test_invocation(void)
{
    uint8_t bytes[16] = {0};
    uint8_t oversize[17] = {0};
    struct gi_unit_invocation output;
    sd_bus_message *message;

    bytes[15] = 0xa5U;
    message = variant_bytes(bytes, sizeof bytes);
    memset(&output, 0x5a, sizeof output);
    assert(gi_parse_unit_invocation(message, &output) == 0);
    assert(memcmp(output.bytes, bytes, sizeof bytes) == 0);
    assert(gi_parse_unit_invocation(message, &output) == 0);
    sd_bus_message_unref(message);

    memset(bytes, 0, sizeof bytes);
    message = variant_bytes(bytes, sizeof bytes);
    memset(&output, 0x5a, sizeof output);
    assert(gi_parse_unit_invocation(message, &output) < 0);
    assert_zero_bytes(output.bytes, sizeof output.bytes);
    sd_bus_message_unref(message);

    bytes[0] = 1U;
    message = variant_bytes(bytes, sizeof bytes - 1U);
    memset(&output, 0x5a, sizeof output);
    assert(gi_parse_unit_invocation(message, &output) < 0);
    assert_zero_bytes(output.bytes, sizeof output.bytes);
    sd_bus_message_unref(message);

    oversize[0] = 1U;
    message = variant_bytes(oversize, sizeof oversize);
    memset(&output, 0x5a, sizeof output);
    assert(gi_parse_unit_invocation(message, &output) < 0);
    assert_zero_bytes(output.bytes, sizeof output.bytes);
    sd_bus_message_unref(message);
}

static void test_uint_decoders(void)
{
    sd_bus_message *message;
    uint32_t output;

    message = variant_uint(1U);
    output = 0U;
    assert(gi_parse_service_main_pid(message, &output) == 0 && output == 1U);
    sd_bus_message_unref(message);

    message = variant_uint((uint32_t)INT_MAX);
    output = 0U;
    assert(gi_parse_service_main_pid(message, &output) == 0 &&
           output == (uint32_t)INT_MAX);
    sd_bus_message_unref(message);

    message = variant_uint(0U);
    output = UINT32_MAX;
    assert(gi_parse_service_main_pid(message, &output) < 0 && output == 0U);
    sd_bus_message_unref(message);

    assert((uint64_t)INT_MAX < (uint64_t)UINT32_MAX);
    message = variant_uint((uint32_t)INT_MAX + 1U);
    output = UINT32_MAX;
    assert(gi_parse_service_main_pid(message, &output) < 0 && output == 0U);
    sd_bus_message_unref(message);

    message = variant_uint(UINT32_MAX);
    output = 0U;
    assert(gi_parse_service_restarts(message, &output) == 0 &&
           output == UINT32_MAX);
    sd_bus_message_unref(message);

    message = variant_uint(0U);
    output = UINT32_MAX;
    assert(gi_parse_service_restarts(message, &output) == 0 && output == 0U);
    sd_bus_message_unref(message);
}

static void test_cgroup_paths(void)
{
    static const char *valid[] = {"/system.slice/ssh.service", "/a_b.c@-9"};
    static const char *invalid[] = {
        "/", "relative", "//system.slice", "/system.slice/", "/./x", "/../x",
        "/system slice/x", "/system\\slice/x", "/system!slice/x", "/system\nx"
    };
    struct gi_service_cgroup output;
    sd_bus_message *message;
    size_t index;
    char boundary[513];
    char overlong[514];

    for (index = 0U; index < sizeof valid / sizeof valid[0]; ++index) {
        message = variant_string(valid[index]);
        memset(&output, 0x5a, sizeof output);
        assert(gi_parse_service_cgroup(message, &output) == 0);
        assert(strcmp(output.path, valid[index]) == 0);
        sd_bus_message_unref(message);
    }
    memset(boundary, 'a', sizeof boundary - 1U);
    boundary[0] = '/';
    boundary[sizeof boundary - 1U] = '\0';
    message = variant_string(boundary);
    memset(&output, 0x5a, sizeof output);
    assert(gi_parse_service_cgroup(message, &output) == 0);
    assert(strcmp(output.path, boundary) == 0);
    sd_bus_message_unref(message);
    for (index = 0U; index < sizeof invalid / sizeof invalid[0]; ++index) {
        message = variant_string(invalid[index]);
        memset(&output, 0x5a, sizeof output);
        assert(gi_parse_service_cgroup(message, &output) < 0);
        assert_zero_bytes(output.path, sizeof output.path);
        sd_bus_message_unref(message);
    }
    memset(overlong, 'a', sizeof overlong - 1U);
    overlong[0] = '/';
    overlong[sizeof overlong - 1U] = '\0';
    message = variant_string(overlong);
    memset(&output, 0x5a, sizeof output);
    assert(gi_parse_service_cgroup(message, &output) < 0);
    assert_zero_bytes(output.path, sizeof output.path);
    sd_bus_message_unref(message);
}

static void test_message_shape_and_nulls(void)
{
    struct gi_unit_invocation invocation;
    struct gi_service_cgroup cgroup;
    sd_bus_message *message;
    uint32_t value;

    message = wrong_top_type();
    memset(&invocation, 0x5a, sizeof invocation);
    assert(gi_parse_unit_invocation(message, &invocation) < 0);
    assert_zero_bytes(invocation.bytes, sizeof invocation.bytes);
    sd_bus_message_unref(message);

    message = wrong_top_type();
    memset(&cgroup, 0x5a, sizeof cgroup);
    assert(gi_parse_service_cgroup(message, &cgroup) < 0);
    assert_zero_bytes(cgroup.path, sizeof cgroup.path);
    sd_bus_message_unref(message);

    message = wrong_inner_type();
    value = UINT32_MAX;
    assert(gi_parse_service_main_pid(message, &value) < 0 && value == 0U);
    sd_bus_message_unref(message);

    message = wrong_inner_type();
    value = UINT32_MAX;
    assert(gi_parse_service_restarts(message, &value) < 0 && value == 0U);
    sd_bus_message_unref(message);

    message = wrong_inner_type();
    memset(&cgroup, 0x5a, sizeof cgroup);
    assert(gi_parse_service_cgroup(message, &cgroup) < 0);
    assert_zero_bytes(cgroup.path, sizeof cgroup.path);
    sd_bus_message_unref(message);

    message = empty_reply();
    value = UINT32_MAX;
    assert(gi_parse_service_restarts(message, &value) < 0 && value == 0U);
    sd_bus_message_unref(message);

    message = trailing_top_value();
    memset(&invocation, 0x5a, sizeof invocation);
    assert(gi_parse_unit_invocation(message, &invocation) < 0);
    assert_zero_bytes(invocation.bytes, sizeof invocation.bytes);
    sd_bus_message_unref(message);

    message = trailing_top_value();
    value = UINT32_MAX;
    assert(gi_parse_service_main_pid(message, &value) < 0 && value == 0U);
    sd_bus_message_unref(message);

    message = trailing_top_value();
    value = UINT32_MAX;
    assert(gi_parse_service_restarts(message, &value) < 0 && value == 0U);
    sd_bus_message_unref(message);

    message = trailing_top_value();
    memset(&cgroup, 0x5a, sizeof cgroup);
    assert(gi_parse_service_cgroup(message, &cgroup) < 0);
    assert_zero_bytes(cgroup.path, sizeof cgroup.path);
    sd_bus_message_unref(message);

    memset(&invocation, 0x5a, sizeof invocation);
    assert(gi_parse_unit_invocation(NULL, &invocation) == -EINVAL);
    assert_zero_bytes(invocation.bytes, sizeof invocation.bytes);
    message = trailing_top_value();
    assert(gi_parse_unit_invocation(message, NULL) == -EINVAL);
    sd_bus_message_unref(message);
    value = UINT32_MAX;
    assert(gi_parse_service_main_pid(NULL, &value) == -EINVAL);
    assert(value == 0U);
    value = UINT32_MAX;
    assert(gi_parse_service_restarts(NULL, &value) == -EINVAL);
    assert(value == 0U);
    value = UINT32_MAX;
    message = trailing_top_value();
    assert(gi_parse_service_main_pid(message, NULL) == -EINVAL);
    sd_bus_message_unref(message);
    memset(&cgroup, 0x5a, sizeof cgroup);
    assert(gi_parse_service_cgroup(NULL, &cgroup) == -EINVAL);
    assert_zero_bytes(cgroup.path, sizeof cgroup.path);
    message = trailing_top_value();
    assert(gi_parse_service_cgroup(message, NULL) == -EINVAL);
    sd_bus_message_unref(message);
}

int main(void)
{
    start_test_bus();
    test_invocation();
    test_uint_decoders();
    test_cgroup_paths();
    test_message_shape_and_nulls();
    sd_bus_close(test_bus);
    sd_bus_unref(test_bus);
    close(peer_fd);
    (void)puts("unit_identity tests: ok");
    return 0;
}
