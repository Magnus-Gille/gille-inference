#include "lockdown.h"
#include <errno.h>
#include <seccomp.h>
#include <stddef.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/socket.h>

int gi_observer_lockdown(void)
{
    /* No process creation, execution, tracing, process memory, IP, mounts, device
     * management, io_uring or namespace changes. File paths and AF_UNIX peers
     * require the separately tested enforcing MAC policy. No caller-supplied rules. */
    static const char *const allowed[] = {
        "read", "write", "readv", "writev", "pread64", "close", "close_range",
        "fstat", "newfstatat", "statx", "lseek", "openat", "readlinkat", "readlink",
        "getdents64", "fcntl", "flock", "brk", "munmap", "madvise",
        "futex", "clock_gettime", "clock_nanosleep", "nanosleep", "getrandom",
        "getpid", "getppid", "gettid", "getuid", "geteuid", "getgid", "getegid",
        "getgroups", "getrlimit", "uname", "rt_sigaction", "rt_sigprocmask",
        "rt_sigreturn", "sigaltstack", "restart_syscall", "poll", "ppoll",
        "epoll_create1", "epoll_ctl", "epoll_wait", "epoll_pwait", "eventfd2",
        "connect", "bind", "listen", "accept4", "getsockopt", "setsockopt",
        "getsockname", "getpeername", "sendmsg", "recvmsg", "sendto", "recvfrom",
        "shutdown", "exit", "exit_group"
    };
    scmp_filter_ctx filter = seccomp_init(SCMP_ACT_ERRNO(EPERM));
    int result = -1;
    if (filter == NULL) return -1;
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) goto done;
    if (seccomp_attr_set(filter, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_KILL_PROCESS) < 0) goto done;
    for (size_t i = 0; i < sizeof allowed / sizeof allowed[0]; ++i) {
        int nr = seccomp_syscall_resolve_name(allowed[i]);
        if (nr == __NR_SCMP_ERROR || seccomp_rule_add(filter, SCMP_ACT_ALLOW, nr, 0) < 0) goto done;
    }
    if (seccomp_rule_add(filter, SCMP_ACT_ALLOW, SCMP_SYS(socket), 2,
            SCMP_A0(SCMP_CMP_EQ, AF_UNIX),
            SCMP_A1(SCMP_CMP_MASKED_EQ, ~(SOCK_CLOEXEC | SOCK_NONBLOCK), SOCK_STREAM)) < 0) goto done;
    /* Existing executable pages remain usable, but no new executable mappings. */
    if (seccomp_rule_add(filter, SCMP_ACT_ALLOW, SCMP_SYS(mmap), 1,
            SCMP_A2(SCMP_CMP_MASKED_EQ, PROT_EXEC, 0)) < 0) goto done;
    if (seccomp_rule_add(filter, SCMP_ACT_ALLOW, SCMP_SYS(mprotect), 1,
            SCMP_A2(SCMP_CMP_MASKED_EQ, PROT_EXEC, 0)) < 0) goto done;
    if (seccomp_load(filter) < 0) goto done;
    result = 0;
done:
    seccomp_release(filter);
    return result;
}
