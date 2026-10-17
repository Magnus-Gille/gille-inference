#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && -d $1 ]] || exit 2
root=$(cd "$(dirname "$0")/../.." && pwd -P)
cc -std=c11 -Wall -Wextra -Werror -pedantic -O2 \
  "$root/native/observer/proc_stat.c" "$root/native/observer/test_proc_stat.c" -o "$1/test-proc-stat"
"$1/test-proc-stat"
cc -std=c11 -Wall -Wextra -Werror -pedantic -O2 \
  "$root/native/observer/counters.c" "$root/native/observer/test_counters.c" -o "$1/test-counters"
"$1/test-counters"
cc -std=c11 -Wall -Wextra -Werror -pedantic -O2 \
  "$root/native/observer/service_census.c" "$root/native/observer/test_service_census.c" \
  $(pkg-config --cflags --libs libsystemd) -o "$1/test-service-census"
"$1/test-service-census"
cc -std=c11 -Wall -Wextra -Werror -pedantic -O2 \
  "$root/native/observer/unit_identity.c" "$root/native/observer/test_unit_identity.c" \
  $(pkg-config --cflags --libs libsystemd) -o "$1/test-unit-identity"
"$1/test-unit-identity"
cc -std=c11 -Wall -Wextra -Werror -pedantic -O2 -fstack-protector-strong -D_FORTIFY_SOURCE=3 \
  "$root/native/observer/lockdown.c" "$root/native/observer/proc_stat.c" "$root/native/observer/counters.c" \
  "$root/native/observer/service_census.c" "$root/native/observer/unit_identity.c" "$root/native/tests/boundary_probe.c" $(pkg-config --cflags --libs libsystemd libseccomp) \
  -Wl,-z,relro,-z,now -o "$1/boundary-probe"
cc -std=c11 -Wall -Wextra -Werror -pedantic -O2 -fstack-protector-strong -D_FORTIFY_SOURCE=3 \
  "$root/native/tests/socket_listener.c" -Wl,-z,relro,-z,now -o "$1/socket-listener"
