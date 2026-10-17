#include "service_census.h"

#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static sd_bus *test_bus;
static int peer_fd;

/* A private socket pair supplies a bus in AUTHENTICATING state. No daemon,
 * system bus, service mutation or received message is involved. */
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
    sd_bus_message *call = NULL, *message = NULL;
    assert(sd_bus_message_new_method_call(test_bus, &call,
        "org.example.Fixture", "/fixture", "org.example.Fixture", "List") >= 0);
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

static void append_unit(sd_bus_message *message, const char *name,
                        const char *object_path, uint32_t job_id,
                        const char *job_type, const char *job_path,
                        const char *following)
{
    assert(sd_bus_message_append(message, "(ssssssouso)", name, "description",
                                 "loaded", "active", "running", following,
                                 object_path, job_id, job_type, job_path) >= 0);
}

static void append_job(sd_bus_message *message, uint32_t id,
                       const char *unit_name, const char *state,
                       const char *job_path, const char *unit_path)
{
    assert(sd_bus_message_append(message, "(usssoo)", id, unit_name, "start", state,
                                 job_path, unit_path) >= 0);
}

static sd_bus_message *units_message(void)
{
    sd_bus_message *message = new_message();

    assert(sd_bus_message_open_container(message, SD_BUS_TYPE_ARRAY,
                                         "(ssssssouso)") >= 0);
    append_unit(message, "alpha.service", "/org/freedesktop/systemd1/unit/alpha_2eservice",
                0U, "", "/", "alpha-alias.service");
    append_unit(message, "beta.service", "/org/freedesktop/systemd1/unit/beta_2eservice",
                0U, "", "/", "");
    assert(sd_bus_message_close_container(message) >= 0);
    finish_message(message);
    return message;
}

static sd_bus_message *jobs_message_with_state(const char *state)
{
    sd_bus_message *message = new_message();

    assert(sd_bus_message_open_container(message, SD_BUS_TYPE_ARRAY,
                                         "(usssoo)") >= 0);
    append_job(message, 7U, "alpha.service", state,
               "/org/freedesktop/systemd1/job/7",
               "/org/freedesktop/systemd1/unit/alpha_2eservice");
    assert(sd_bus_message_close_container(message) >= 0);
    finish_message(message);
    return message;
}

static sd_bus_message *jobs_message(void)
{
    return jobs_message_with_state("waiting");
}

static void test_valid_units(void)
{
    sd_bus_message *message = units_message();
    static struct gi_systemd_units parsed;

    assert(gi_parse_systemd_units(message, &parsed) == 0);
    assert(parsed.count == 2U);
    assert(strcmp(parsed.items[0].name, "alpha.service") == 0);
    assert(strcmp(parsed.items[0].active_state, "active") == 0);
    assert(strcmp(parsed.items[0].following, "alpha-alias.service") == 0);
    assert(strcmp(parsed.items[0].object_path,
                  "/org/freedesktop/systemd1/unit/alpha_2eservice") == 0);
    assert(parsed.items[0].job_id == 0U);
    assert(strcmp(parsed.items[0].job_path, "/") == 0);
    assert(parsed.items[1].following[0] == '\0');
    sd_bus_message_unref(message);
}

static void test_valid_jobs(void)
{
    sd_bus_message *message = jobs_message();
    static struct gi_systemd_jobs parsed;

    assert(gi_parse_systemd_jobs(message, &parsed) == 0);
    assert(parsed.count == 1U);
    assert(parsed.items[0].id == 7U);
    assert(strcmp(parsed.items[0].type, "start") == 0);
    assert(strcmp(parsed.items[0].unit_name, "alpha.service") == 0);
    assert(strcmp(parsed.items[0].state, "waiting") == 0);
    sd_bus_message_unref(message);
}

static void test_duplicate_unit_is_atomic(void)
{
    sd_bus_message *message = new_message();
    static struct gi_systemd_units parsed;

    assert(sd_bus_message_open_container(message, SD_BUS_TYPE_ARRAY,
                                         "(ssssssouso)") >= 0);
    append_unit(message, "duplicate.service", "/org/freedesktop/systemd1/unit/one",
                0U, "", "/", "");
    append_unit(message, "duplicate.service", "/org/freedesktop/systemd1/unit/two",
                0U, "", "/", "");
    assert(sd_bus_message_close_container(message) >= 0);
    finish_message(message);
    memset(&parsed, 0xa5, sizeof parsed);
    assert(gi_parse_systemd_units(message, &parsed) == -EINVAL);
    assert(parsed.count == 0U);
    assert(parsed.items[0].name[0] == '\0');
    sd_bus_message_unref(message);
}

static void test_job_consistency_and_duplicates(void)
{
    sd_bus_message *message = new_message();
    static struct gi_systemd_units units;
    static struct gi_systemd_jobs jobs;

    assert(sd_bus_message_open_container(message, SD_BUS_TYPE_ARRAY,
                                         "(ssssssouso)") >= 0);
    append_unit(message, "bad.service", "/org/freedesktop/systemd1/unit/bad",
                0U, "start", "/org/freedesktop/systemd1/job/1", "");
    assert(sd_bus_message_close_container(message) >= 0);
    finish_message(message);
    memset(&units, 0x5a, sizeof units);
    assert(gi_parse_systemd_units(message, &units) == -EINVAL);
    assert(units.count == 0U);
    sd_bus_message_unref(message);

    message = new_message();
    assert(sd_bus_message_open_container(message, SD_BUS_TYPE_ARRAY,
                                         "(usssoo)") >= 0);
    assert(sd_bus_message_append(message, "(usssoo)", 9U, "a.service", "start", "waiting",
                                 "/org/freedesktop/systemd1/job/9",
                                 "/org/freedesktop/systemd1/unit/a") >= 0);
    assert(sd_bus_message_append(message, "(usssoo)", 9U, "b.service", "stop", "running",
                                 "/org/freedesktop/systemd1/job/10",
                                 "/org/freedesktop/systemd1/unit/b") >= 0);
    assert(sd_bus_message_close_container(message) >= 0);
    finish_message(message);
    memset(&jobs, 0x5a, sizeof jobs);
    assert(gi_parse_systemd_jobs(message, &jobs) == -EINVAL);
    assert(jobs.count == 0U);
    sd_bus_message_unref(message);
}

static void test_wrong_signature_and_null_arguments(void)
{
    sd_bus_message *message = new_message();
    static struct gi_systemd_units units;

    assert(sd_bus_message_open_container(message, SD_BUS_TYPE_ARRAY, "s") >= 0);
    assert(sd_bus_message_append(message, "s", "not-a-unit-tuple") >= 0);
    assert(sd_bus_message_close_container(message) >= 0);
    finish_message(message);
    assert(gi_parse_systemd_units(message, &units) == -EPROTO);
    assert(gi_parse_systemd_units(NULL, &units) == -EINVAL);
    assert(gi_parse_systemd_units(message, NULL) == -EINVAL);
    sd_bus_message_unref(message);
}

static void test_unit_cap_is_atomic(void)
{
    sd_bus_message *message = new_message();
    static struct gi_systemd_units units;
    unsigned int index;

    assert(sd_bus_message_open_container(message, SD_BUS_TYPE_ARRAY,
                                         "(ssssssouso)") >= 0);
    for (index = 0U; index < GI_SYSTEMD_MAX_UNITS + 1U; ++index) {
        char name[64];
        char object_path[128];

        assert(snprintf(name, sizeof name, "unit-%u.service", index) > 0);
        assert(snprintf(object_path, sizeof object_path,
                        "/org/freedesktop/systemd1/unit/u%u", index) > 0);
        append_unit(message, name, object_path, 0U, "", "/", "");
    }
    assert(sd_bus_message_close_container(message) >= 0);
    finish_message(message);
    memset(&units, 0x5a, sizeof units);
    assert(gi_parse_systemd_units(message, &units) == -E2BIG);
    assert(units.count == 0U);
    assert(units.items[0].name[0] == '\0');
    sd_bus_message_unref(message);
}

static void test_empty_or_overlong_job_state_is_atomic(void)
{
    static struct gi_systemd_jobs jobs;
    static const char empty_state[] = "";
    char overlong_state[GI_SYSTEMD_JOB_TYPE_MAX + 2U];
    const char *states[] = { empty_state, overlong_state };
    size_t index;

    memset(overlong_state, 'x', sizeof overlong_state - 1U);
    overlong_state[sizeof overlong_state - 1U] = '\0';
    for (index = 0U; index < sizeof states / sizeof states[0]; ++index) {
        sd_bus_message *message = jobs_message_with_state(states[index]);

        memset(&jobs, 0x5a, sizeof jobs);
        assert(gi_parse_systemd_jobs(message, &jobs) == -EINVAL);
        assert(jobs.count == 0U);
        assert(jobs.items[0].state[0] == '\0');
        sd_bus_message_unref(message);
    }
}

static void test_empty_and_reused_replies(void)
{
    static struct gi_systemd_units units;
    static struct gi_systemd_jobs jobs;
    sd_bus_message *m = new_message();
    assert(sd_bus_message_open_container(m, SD_BUS_TYPE_ARRAY, "(usssoo)") >= 0);
    assert(sd_bus_message_close_container(m) >= 0);
    finish_message(m);
    assert(gi_parse_systemd_jobs(m, &jobs) == 0 && jobs.count == 0);
    sd_bus_message_unref(m);
    m = units_message();
    assert(gi_parse_systemd_units(m, &units) == 0 && units.count == 2);
    assert(gi_parse_systemd_units(m, &units) == 0 && units.count == 2);
    sd_bus_message_unref(m);
}

static void test_job_cap_and_extra_payload(void)
{
    static struct gi_systemd_jobs jobs;
    sd_bus_message *m = new_message();
    assert(sd_bus_message_open_container(m, SD_BUS_TYPE_ARRAY, "(usssoo)") >= 0);
    for (unsigned int i = 1; i <= GI_SYSTEMD_MAX_JOBS + 1U; ++i) {
        char name[64], path[128], unit_path[128];
        assert(snprintf(name, sizeof name, "unit-%u.service", i) > 0);
        assert(snprintf(path, sizeof path, "/org/freedesktop/systemd1/job/j%u", i) > 0);
        assert(snprintf(unit_path, sizeof unit_path, "/org/freedesktop/systemd1/unit/u%u", i) > 0);
        append_job(m, i, name, "waiting", path, unit_path);
    }
    assert(sd_bus_message_close_container(m) >= 0);
    finish_message(m);
    assert(gi_parse_systemd_jobs(m, &jobs) == -E2BIG && jobs.count == 0);
    assert(jobs.items[0].id == 0);
    sd_bus_message_unref(m);
    m = new_message();
    assert(sd_bus_message_open_container(m, SD_BUS_TYPE_ARRAY, "(usssoo)") >= 0);
    assert(sd_bus_message_close_container(m) >= 0);
    assert(sd_bus_message_append(m, "s", "trailing") >= 0);
    finish_message(m);
    assert(gi_parse_systemd_jobs(m, &jobs) == -EPROTO && jobs.count == 0);
    sd_bus_message_unref(m);
}

int main(void)
{
    start_test_bus();
    test_empty_and_reused_replies();
    test_job_cap_and_extra_payload();
    test_valid_units();
    test_valid_jobs();
    test_duplicate_unit_is_atomic();
    test_job_consistency_and_duplicates();
    test_wrong_signature_and_null_arguments();
    test_unit_cap_is_atomic();
    test_empty_or_overlong_job_state_is_atomic();
    /* No messages were sent: do not wait for authentication to flush. */
    sd_bus_close(test_bus);
    sd_bus_unref(test_bus);
    close(peer_fd);
    (void)puts("service_census tests: ok");
    return 0;
}
