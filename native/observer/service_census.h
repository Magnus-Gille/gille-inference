#ifndef GI_SERVICE_CENSUS_H
#define GI_SERVICE_CENSUS_H

#include <stddef.h>
#include <stdint.h>

#include <systemd/sd-bus.h>

#define GI_SYSTEMD_MAX_UNITS ((size_t)4096U)
#define GI_SYSTEMD_MAX_JOBS ((size_t)4096U)
#define GI_SYSTEMD_UNIT_NAME_MAX ((size_t)255U)
#define GI_SYSTEMD_STATE_MAX ((size_t)32U)
#define GI_SYSTEMD_JOB_TYPE_MAX ((size_t)32U)
#define GI_SYSTEMD_OBJECT_PATH_MAX ((size_t)1024U)
/* Descriptions are discarded, but still bounded before they are skipped. */
#define GI_SYSTEMD_DESCRIPTION_MAX ((size_t)4096U)

struct gi_systemd_unit {
    char name[GI_SYSTEMD_UNIT_NAME_MAX + 1U];
    char load_state[GI_SYSTEMD_STATE_MAX + 1U];
    char active_state[GI_SYSTEMD_STATE_MAX + 1U];
    char sub_state[GI_SYSTEMD_STATE_MAX + 1U];
    char following[GI_SYSTEMD_UNIT_NAME_MAX + 1U];
    char object_path[GI_SYSTEMD_OBJECT_PATH_MAX + 1U];
    uint32_t job_id;
    char job_type[GI_SYSTEMD_JOB_TYPE_MAX + 1U];
    char job_path[GI_SYSTEMD_OBJECT_PATH_MAX + 1U];
};

struct gi_systemd_units {
    struct gi_systemd_unit items[GI_SYSTEMD_MAX_UNITS];
    size_t count;
};

struct gi_systemd_job {
    uint32_t id;
    char unit_name[GI_SYSTEMD_UNIT_NAME_MAX + 1U];
    char type[GI_SYSTEMD_JOB_TYPE_MAX + 1U];
    char state[GI_SYSTEMD_STATE_MAX + 1U];
    char job_path[GI_SYSTEMD_OBJECT_PATH_MAX + 1U];
    char unit_path[GI_SYSTEMD_OBJECT_PATH_MAX + 1U];
};

struct gi_systemd_jobs {
    struct gi_systemd_job items[GI_SYSTEMD_MAX_JOBS];
    size_t count;
};

/* Rewind and parse one complete sealed reply. Any failure clears all output.
 * Only loaded units are listed; this is not a complete host inventory. */
int gi_parse_systemd_units(sd_bus_message *reply, struct gi_systemd_units *out);

/* Parse one complete org.freedesktop.systemd1.Manager.ListJobs reply. */
int gi_parse_systemd_jobs(sd_bus_message *reply, struct gi_systemd_jobs *out);

#endif
