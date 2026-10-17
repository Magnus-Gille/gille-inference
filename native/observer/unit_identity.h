#ifndef GI_UNIT_IDENTITY_H
#define GI_UNIT_IDENTITY_H

#include <stdint.h>

#include <systemd/sd-bus.h>

struct gi_unit_invocation {
    uint8_t bytes[16];
};

struct gi_service_cgroup {
    char path[513];
};

/* Decode complete sealed org.freedesktop.DBus.Properties.Get replies. */
int gi_parse_unit_invocation(sd_bus_message *reply,
                             struct gi_unit_invocation *out);
int gi_parse_service_main_pid(sd_bus_message *reply, uint32_t *out);
int gi_parse_service_restarts(sd_bus_message *reply, uint32_t *out);
int gi_parse_service_cgroup(sd_bus_message *reply,
                            struct gi_service_cgroup *out);

#endif
