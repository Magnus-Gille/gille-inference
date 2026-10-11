#include "service_census.h"

#include <errno.h>
#include <stdint.h>
#include <string.h>

static int gi_utf8_is_valid(const char *value, size_t length)
{
    size_t index = 0U;

    while (index < length) {
        unsigned char first = (unsigned char)value[index];

        if (first <= 0x7fU) {
            ++index;
        } else if (first >= 0xc2U && first <= 0xdfU) {
            if (index + 1U >= length ||
                ((unsigned char)value[index + 1U] & 0xc0U) != 0x80U) {
                return 0;
            }
            index += 2U;
        } else if (first == 0xe0U) {
            if (index + 2U >= length ||
                (unsigned char)value[index + 1U] < 0xa0U ||
                (unsigned char)value[index + 1U] > 0xbfU ||
                ((unsigned char)value[index + 2U] & 0xc0U) != 0x80U) {
                return 0;
            }
            index += 3U;
        } else if ((first >= 0xe1U && first <= 0xecU) ||
                   (first >= 0xeeU && first <= 0xefU)) {
            if (index + 2U >= length ||
                ((unsigned char)value[index + 1U] & 0xc0U) != 0x80U ||
                ((unsigned char)value[index + 2U] & 0xc0U) != 0x80U) {
                return 0;
            }
            index += 3U;
        } else if (first == 0xedU) {
            if (index + 2U >= length ||
                (unsigned char)value[index + 1U] < 0x80U ||
                (unsigned char)value[index + 1U] > 0x9fU ||
                ((unsigned char)value[index + 2U] & 0xc0U) != 0x80U) {
                return 0;
            }
            index += 3U;
        } else if (first == 0xf0U) {
            if (index + 3U >= length ||
                (unsigned char)value[index + 1U] < 0x90U ||
                (unsigned char)value[index + 1U] > 0xbfU ||
                ((unsigned char)value[index + 2U] & 0xc0U) != 0x80U ||
                ((unsigned char)value[index + 3U] & 0xc0U) != 0x80U) {
                return 0;
            }
            index += 4U;
        } else if (first >= 0xf1U && first <= 0xf3U) {
            if (index + 3U >= length ||
                ((unsigned char)value[index + 1U] & 0xc0U) != 0x80U ||
                ((unsigned char)value[index + 2U] & 0xc0U) != 0x80U ||
                ((unsigned char)value[index + 3U] & 0xc0U) != 0x80U) {
                return 0;
            }
            index += 4U;
        } else if (first == 0xf4U) {
            if (index + 3U >= length ||
                (unsigned char)value[index + 1U] < 0x80U ||
                (unsigned char)value[index + 1U] > 0x8fU ||
                ((unsigned char)value[index + 2U] & 0xc0U) != 0x80U ||
                ((unsigned char)value[index + 3U] & 0xc0U) != 0x80U) {
                return 0;
            }
            index += 4U;
        } else {
            return 0;
        }
    }
    return 1;
}

static int gi_string_length(const char *value, size_t maximum, size_t *length)
{
    size_t index;

    if (value == NULL || length == NULL) {
        return -EINVAL;
    }
    for (index = 0U; index <= maximum; ++index) {
        if (value[index] == '\0') {
            if (!gi_utf8_is_valid(value, index)) {
                return -EINVAL;
            }
            *length = index;
            return 0;
        }
    }
    return -E2BIG;
}

static int gi_copy_string(char *destination, size_t destination_size,
                          const char *value, size_t maximum, int mandatory)
{
    size_t length;
    int result;

    result = gi_string_length(value, maximum, &length);
    if (result < 0 || (mandatory && length == 0U)) {
        return result < 0 ? result : -EINVAL;
    }
    if (destination_size <= length) {
        return -E2BIG;
    }
    memcpy(destination, value, length + 1U);
    return 0;
}

static int gi_valid_object_path(const char *value, int allow_root)
{
    size_t length;
    size_t index;

    if (gi_string_length(value, GI_SYSTEMD_OBJECT_PATH_MAX, &length) < 0 ||
        length == 0U || value[0] != '/') {
        return -EINVAL;
    }
    if (length == 1U) {
        return allow_root ? 0 : -EINVAL;
    }
    for (index = 1U; index < length; ++index) {
        unsigned char character = (unsigned char)value[index];

        if (character == '/') {
            if (index + 1U == length || value[index + 1U] == '/') {
                return -EINVAL;
            }
        } else if (!((character >= 'A' && character <= 'Z') ||
                     (character >= 'a' && character <= 'z') ||
                     (character >= '0' && character <= '9') ||
                     character == '_')) {
            return -EINVAL;
        }
    }
    return 0;
}

static int gi_expected_signature(sd_bus_message *reply, const char *expected)
{
    const char *signature;

    if (reply == NULL || expected == NULL) {
        return -EINVAL;
    }
    signature = sd_bus_message_get_signature(reply, 1);
    if (signature == NULL || strcmp(signature, expected) != 0) {
        return -EPROTO;
    }
    return sd_bus_message_rewind(reply, 1);
}

static int gi_units_have_duplicate(const struct gi_systemd_units *units,
                                   const char *name, const char *object_path)
{
    size_t index;

    for (index = 0U; index < units->count; ++index) {
        if (strcmp(units->items[index].name, name) == 0 ||
            strcmp(units->items[index].object_path, object_path) == 0) {
            return 1;
        }
    }
    return 0;
}

static int gi_jobs_have_duplicate(const struct gi_systemd_jobs *jobs,
                                  uint32_t id, const char *job_path)
{
    size_t index;

    for (index = 0U; index < jobs->count; ++index) {
        if (jobs->items[index].id == id ||
            strcmp(jobs->items[index].job_path, job_path) == 0) {
            return 1;
        }
    }
    return 0;
}

int gi_parse_systemd_units(sd_bus_message *reply, struct gi_systemd_units *out)
{
    static const char expected_signature[] = "a(ssssssouso)";
    static const char tuple_signature[] = "(ssssssouso)";
    int result;
    int read_result;

    if (out == NULL) {
        return -EINVAL;
    }
    memset(out, 0, sizeof *out);
    result = gi_expected_signature(reply, expected_signature);
    if (result < 0) {
        return result;
    }
    result = sd_bus_message_enter_container(reply, SD_BUS_TYPE_ARRAY,
                                            tuple_signature);
    if (result < 0) {
        goto fail;
    }
    for (;;) {
        const char *name;
        const char *description;
        const char *load_state;
        const char *active_state;
        const char *sub_state;
        const char *following;
        const char *object_path;
        uint32_t job_id;
        const char *job_type;
        const char *job_path;
        size_t index;

        read_result = sd_bus_message_read(reply, tuple_signature,
                                          &name, &description, &load_state,
                                          &active_state, &sub_state, &following,
                                          &object_path, &job_id, &job_type,
                                          &job_path);
        if (read_result < 0) {
            result = read_result;
            goto fail_array;
        }
        if (read_result == 0) {
            break;
        }
        if (out->count >= GI_SYSTEMD_MAX_UNITS) {
            result = -E2BIG;
            goto fail_array;
        }
        if (gi_string_length(description, GI_SYSTEMD_DESCRIPTION_MAX, &index) < 0 ||
            gi_string_length(following, GI_SYSTEMD_UNIT_NAME_MAX, &index) < 0 ||
            gi_copy_string(out->items[out->count].name,
                           sizeof out->items[out->count].name, name,
                           GI_SYSTEMD_UNIT_NAME_MAX, 1) < 0 ||
            gi_copy_string(out->items[out->count].load_state,
                           sizeof out->items[out->count].load_state, load_state,
                           GI_SYSTEMD_STATE_MAX, 1) < 0 ||
            gi_copy_string(out->items[out->count].active_state,
                           sizeof out->items[out->count].active_state,
                           active_state, GI_SYSTEMD_STATE_MAX, 1) < 0 ||
            gi_copy_string(out->items[out->count].sub_state,
                           sizeof out->items[out->count].sub_state, sub_state,
                           GI_SYSTEMD_STATE_MAX, 1) < 0 ||
            gi_copy_string(out->items[out->count].following,
                           sizeof out->items[out->count].following, following,
                           GI_SYSTEMD_UNIT_NAME_MAX, 0) < 0 ||
            gi_copy_string(out->items[out->count].object_path,
                           sizeof out->items[out->count].object_path, object_path,
                           GI_SYSTEMD_OBJECT_PATH_MAX, 1) < 0 ||
            gi_valid_object_path(object_path, 0) < 0 ||
            gi_copy_string(out->items[out->count].job_type,
                           sizeof out->items[out->count].job_type, job_type,
                           GI_SYSTEMD_JOB_TYPE_MAX, job_id != 0U) < 0 ||
            gi_copy_string(out->items[out->count].job_path,
                           sizeof out->items[out->count].job_path, job_path,
                           GI_SYSTEMD_OBJECT_PATH_MAX, 1) < 0 ||
            gi_valid_object_path(job_path, 1) < 0) {
            result = -EINVAL;
            goto fail_array;
        }
        if ((job_id == 0U &&
             (out->items[out->count].job_type[0] != '\0' ||
              strcmp(out->items[out->count].job_path, "/") != 0)) ||
            (job_id != 0U && strcmp(out->items[out->count].job_path, "/") == 0) ||
            gi_units_have_duplicate(out, out->items[out->count].name,
                                    out->items[out->count].object_path)) {
            result = -EINVAL;
            goto fail_array;
        }
        out->items[out->count].job_id = job_id;
        ++out->count;
    }
    result = sd_bus_message_exit_container(reply);
    if (result < 0 || sd_bus_message_at_end(reply, 1) <= 0) {
        result = result < 0 ? result : -EPROTO;
        goto fail;
    }
    return 0;

fail_array:
    (void)sd_bus_message_exit_container(reply);
fail:
    memset(out, 0, sizeof *out);
    return result;
}

int gi_parse_systemd_jobs(sd_bus_message *reply, struct gi_systemd_jobs *out)
{
    static const char expected_signature[] = "a(usssoo)";
    static const char tuple_signature[] = "(usssoo)";
    int result;
    int read_result;

    if (out == NULL) {
        return -EINVAL;
    }
    memset(out, 0, sizeof *out);
    result = gi_expected_signature(reply, expected_signature);
    if (result < 0) {
        return result;
    }
    result = sd_bus_message_enter_container(reply, SD_BUS_TYPE_ARRAY,
                                            tuple_signature);
    if (result < 0) {
        goto fail;
    }
    for (;;) {
        uint32_t id;
        const char *unit_name;
        const char *type;
        const char *state;
        const char *job_path;
        const char *unit_path;

        read_result = sd_bus_message_read(reply, tuple_signature, &id,
                                          &unit_name, &type, &state, &job_path,
                                          &unit_path);
        if (read_result < 0) {
            result = read_result;
            goto fail_array_jobs;
        }
        if (read_result == 0) {
            break;
        }
        if (out->count >= GI_SYSTEMD_MAX_JOBS) {
            result = -E2BIG;
            goto fail_array_jobs;
        }
        if (id == 0U ||
            gi_copy_string(out->items[out->count].unit_name,
                           sizeof out->items[out->count].unit_name, unit_name,
                           GI_SYSTEMD_UNIT_NAME_MAX, 1) < 0 ||
            gi_copy_string(out->items[out->count].type,
                           sizeof out->items[out->count].type, type,
                           GI_SYSTEMD_JOB_TYPE_MAX, 1) < 0 ||
            gi_copy_string(out->items[out->count].state,
                           sizeof out->items[out->count].state, state,
                           GI_SYSTEMD_STATE_MAX, 1) < 0 ||
            gi_copy_string(out->items[out->count].job_path,
                           sizeof out->items[out->count].job_path, job_path,
                           GI_SYSTEMD_OBJECT_PATH_MAX, 1) < 0 ||
            gi_copy_string(out->items[out->count].unit_path,
                           sizeof out->items[out->count].unit_path, unit_path,
                           GI_SYSTEMD_OBJECT_PATH_MAX, 1) < 0 ||
            gi_valid_object_path(job_path, 0) < 0 ||
            gi_valid_object_path(unit_path, 0) < 0 ||
            gi_jobs_have_duplicate(out, id, out->items[out->count].job_path)) {
            result = -EINVAL;
            goto fail_array_jobs;
        }
        out->items[out->count].id = id;
        ++out->count;
    }
    result = sd_bus_message_exit_container(reply);
    if (result < 0 || sd_bus_message_at_end(reply, 1) <= 0) {
        result = result < 0 ? result : -EPROTO;
        goto fail;
    }
    return 0;

fail_array_jobs:
    (void)sd_bus_message_exit_container(reply);
fail:
    memset(out, 0, sizeof *out);
    return result;
}
