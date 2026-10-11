#define _GNU_SOURCE
/* Disposable Linux fixture only. Not an observer, launcher or M5 executable. */
#include "../observer/lockdown.h"
#include "../observer/proc_stat.h"
#include "../observer/counters.h"
#include "../observer/service_census.h"
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <stddef.h>
#include <systemd/sd-bus.h>
#include <unistd.h>

static int failures;
static void check(const char *name, bool passed)
{
    /* name is a source constant; never emit file, process or bus contents. */
    printf("%s: %s\n", name, passed ? "pass" : "FAIL");
    if (!passed) ++failures;
}

static bool denied_open(const char *path)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
    int error = errno;
    if (fd >= 0) { close(fd); return false; }
    return error == EACCES || error == EPERM;
}

static void check_unix_peer(bool abstract, bool control)
{
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    const char *name = abstract ? "gi-observer-fixture-denied" :
        "/run/gi-observer-fixture/peers/forbidden.sock";
    size_t size = strlen(name);
    memcpy(address.sun_path + (abstract ? 1 : 0), name, size + 1);
    socklen_t length = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + size + 1);
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    int result = fd >= 0 ? connect(fd, (struct sockaddr *)&address, length) : -1;
    int error = errno;
    check(abstract ? "abstract-peer-boundary" : "pathname-peer-boundary",
        fd >= 0 && (control ? result == 0 : result == -1 && (error == EACCES || error == EPERM)));
    if (fd >= 0) close(fd);
}

/* Only source-constant metadata paths reach this helper. Require EOF within the
 * parser bound; short reads do not turn a truncated file into a valid sample. */
static bool check_counter_file(const char *path, bool memory)
{
    char data[65537];
    size_t used = 0;
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) return false;
    bool eof = false;
    while (used < sizeof data) {
        ssize_t count = read(fd, data + used, sizeof data - used);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) break;
        if (count == 0) { eof = true; break; }
        used += (size_t)count;
    }
    close(fd);
    uint64_t value = 0;
    return eof && (memory ? gi_parse_mem_available(data, used, &value) :
        gi_parse_oom_kill(data, used, &value)) == 0;
}

static int fixed_bus(sd_bus **bus)
{
    int r = sd_bus_new(bus);
    if (r >= 0) r = sd_bus_set_address(*bus, "unix:path=/run/dbus/system_bus_socket");
    if (r >= 0) r = sd_bus_set_bus_client(*bus, 1);
    if (r >= 0) r = sd_bus_set_method_call_timeout(*bus, UINT64_C(500000));
    if (r >= 0) r = sd_bus_start(*bus);
    return r;
}

static void check_bus(sd_bus *bus, bool control)
{
    sd_bus_error error = SD_BUS_ERROR_NULL;
    sd_bus_message *reply = NULL;
    int r = sd_bus_call_method(bus, "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
        "org.freedesktop.DBus.Properties", "Get", &error, &reply, "ss",
        "org.freedesktop.systemd1.Manager", "Version");
    check("systemd-property", r >= 0);
    sd_bus_message_unref(reply); reply = NULL; sd_bus_error_free(&error);
    r = sd_bus_call_method(bus, "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager", "ListUnits", &error, &reply, "");
    static struct gi_systemd_units units;
    bool units_ok = r >= 0 && gi_parse_systemd_units(reply, &units) == 0;
    bool active_sentinel = false;
    if (units_ok) for (size_t i = 0; i < units.count; ++i) {
        const struct gi_systemd_unit *unit = &units.items[i];
        if (strcmp(unit->name, "gi-observer-fixture-target.service") == 0 &&
            strcmp(unit->load_state, "loaded") == 0 &&
            strcmp(unit->active_state, "active") == 0 &&
            strcmp(unit->sub_state, "running") == 0) active_sentinel = true;
    }
    check("systemd-units", units_ok);
    check("systemd-active-cross-uid-service", active_sentinel);
    sd_bus_message_unref(reply); reply = NULL; sd_bus_error_free(&error);
    r = sd_bus_call_method(bus, "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager", "ListJobs", &error, &reply, "");
    static struct gi_systemd_jobs jobs;
    bool jobs_ok = r >= 0 && gi_parse_systemd_jobs(reply, &jobs) == 0;
    bool pending_sentinel = false;
    if (jobs_ok) for (size_t i = 0; i < jobs.count; ++i) {
        const struct gi_systemd_job *job = &jobs.items[i];
        if (strcmp(job->unit_name, "gi-observer-fixture-waiting.service") == 0 &&
            strcmp(job->type, "start") == 0 && strcmp(job->state, "waiting") == 0 &&
            job->id > 0) pending_sentinel = true;
    }
    check("systemd-jobs", jobs_ok);
    check("systemd-pending-job", pending_sentinel);
    sd_bus_message_unref(reply); reply = NULL; sd_bus_error_free(&error);

    /* Ping has no side effects and normally requires no polkit authorization.
     * Its rejection distinguishes method mediation from a generic nonroot deny. */
    r = sd_bus_call_method(bus, "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
        "org.freedesktop.DBus.Peer", "Ping", &error, &reply, "");
    check("bus-method-mediation", control ? r >= 0 :
        r < 0 && sd_bus_error_has_name(&error, SD_BUS_ERROR_ACCESS_DENIED));
    sd_bus_message_unref(reply); reply = NULL; sd_bus_error_free(&error);
    if (control) return; /* Never attempt mutation in the unconfined control. */
    r = sd_bus_call_method(bus, "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager", "StartUnit", &error, &reply, "ss",
        "gi-observer-fixture-canary.service", "fail");
    check("service-mutation-denied", r < 0 && sd_bus_error_has_name(&error, SD_BUS_ERROR_ACCESS_DENIED));
    sd_bus_message_unref(reply); sd_bus_error_free(&error);
}

int main(int argc, char **argv)
{
    bool control = argc == 2 && strcmp(argv[1], "--control") == 0;
    if (argc != 1 && !control) return 2;
    if (getuid() == 0 || geteuid() == 0) return 2;
    FILE *pidfile = fopen("/run/gi-observer-fixture/target.pid", "r");
    unsigned target = 0;
    if (!pidfile || fscanf(pidfile, "%u", &target) != 1 || target == 0 || target > INT32_MAX) return 2;
    fclose(pidfile);
    if (gi_observer_lockdown() != 0) return 2;
    check("memory-metadata", check_counter_file("/proc/meminfo", true));
    check("global-oom-metadata", check_counter_file("/proc/vmstat", false));
    check("unit-oom-metadata", check_counter_file(
        "/sys/fs/cgroup/system.slice/gi-observer-fixture-target.service/memory.events", false));
    check_unix_peer(false, control);
    check_unix_peer(true, control);

    char path[128], data[8193];
    snprintf(path, sizeof path, "/proc/%u/stat", target);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    ssize_t size = fd >= 0 ? read(fd, data, sizeof data) : -1;
    if (fd >= 0) close(fd);
    struct gi_proc_stat stat;
    check("cross-uid-proc-stat", size > 0 && (size_t)size <= 8192 &&
        gi_parse_proc_stat(data, (size_t)size, &stat) == 0 && stat.pid == target && stat.start_ticks > 0);
    snprintf(path, sizeof path, "/proc/%u/exe", target);
    check("cross-uid-exe-link", readlink(path, data, sizeof data) > 0);
    if (control) {
        fd = open("/run/gi-observer-fixture/forbidden", O_RDONLY | O_CLOEXEC);
        check("dac-control-readable", fd >= 0);
        if (fd >= 0) close(fd);
    } else {
        check("mac-forbidden-file", denied_open("/run/gi-observer-fixture/forbidden"));
        /* Opens only, no content reads even if confinement is broken. The
         * target is this fixture's credential-free synthetic sleep process. */
        static const char *const forbidden[] = {"cmdline", "environ", "mem", "root"};
        for (size_t i = 0; i < sizeof forbidden / sizeof forbidden[0]; ++i) {
            snprintf(path, sizeof path, "/proc/%u/%s", target, forbidden[i]);
            check("mac-forbidden-proc-open", denied_open(path));
        }
    }
    errno = 0;
    check("ptrace-denied", ptrace(PTRACE_TRACEME, 0, NULL, NULL) == -1 && errno == EPERM);
    errno = 0;
    check("process-memory-denied", syscall(SYS_process_vm_readv, getpid(), NULL, 0, NULL, 0, 0) == -1 && errno == EPERM);
    errno = 0;
    pid_t child = fork();
    if (child == 0) _exit(99);
    check("process-creation-denied", child == -1 && errno == EPERM);
    errno = 0;
    fd = socket(AF_INET, SOCK_STREAM, 0);
    check("ip-socket-denied", fd == -1 && errno == EPERM);
    if (fd >= 0) close(fd);
    char *const args[] = {"missing", NULL};
    char *const env[] = {NULL};
    errno = 0;
    check("exec-denied", execve("/", args, env) == -1 && errno == EPERM);
    errno = 0;
    check("remap-denied", syscall(SYS_mremap, NULL, 0, 0, 0) == -1 && errno == EPERM);
    errno = 0;
    void *mapping = mmap(NULL, 4096, PROT_READ | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    check("new-executable-memory-denied", mapping == MAP_FAILED && errno == EPERM);
    if (mapping != MAP_FAILED) munmap(mapping, 4096);
    sd_bus *bus = NULL;
    int r = fixed_bus(&bus);
    check("fixed-system-bus", r >= 0);
    if (r >= 0) check_bus(bus, control);
    sd_bus_flush_close_unref(bus);
    puts("qualifiesObserver: false");
    return failures ? 1 : 0;
}
