#define _GNU_SOURCE

/*
 * Minimal, version-pinned R610 Linux demo for NVIDIA ClockClient controls.
 *
 * Tested on RTX 5090 / 610.57.04.  The 0x83c layout is private and must not be
 * assumed to be stable across driver branches.  With no arguments this only
 * reads the current XBAR offsets and measured clock.  A write is refused unless
 * the runtime identity and private INFO layout match the tested tuple.  The
 * write form snapshots the complete control and relevant V/F STATUS records,
 * applies the request, verifies the full 0x83c-byte readback, samples the clock,
 * then restores and verifies both objects.
 */

#include <errno.h>
#include <fcntl.h>
#include <glob.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define NV_IOCTL_MAGIC 'F'
#define NV_IOCTL_BASE 200
#define NV_ESC_REGISTER_FD (NV_IOCTL_BASE + 1)
#define NV_ESC_RM_FREE 0x29
#define NV_ESC_RM_CONTROL 0x2a
#define NV_ESC_RM_ALLOC 0x2b

#define NV01_ROOT 0x00000000U
#define NV01_DEVICE_0 0x00000080U
#define NV20_SUBDEVICE_0 0x00002080U

#define CLK_MEASURE_FREQ 0x20809006U
#define CLK_DOMAINS_GET_INFO 0x20809019U
#define CLK_DOMAINS_GET_CONTROL 0x2080901bU
#define CLK_DOMAINS_SET_CONTROL 0x2080d01cU
#define CLK_DOMAINS_INFO_SIZE 0x3030U
#define CLK_DOMAINS_CONTROL_SIZE 0x83cU

#define CLK_VF_POINTS_GET_STATUS 0x20809022U
#define CLK_VF_POINTS_STATUS_SIZE 0x98208U
#define VF_PRIMARY_MASK_OFFSET 0x004U
#define VF_STATUS_RECORD_BASE 0x0d8U
#define VF_STATUS_RECORD_STRIDE 0x098U

#define DOMAIN_HEADER_SIZE 0x3cU
#define DOMAIN_STRIDE 0x40U
#define DOMAIN_INFO_HEADER_SIZE 0x30U
#define DOMAIN_INFO_STRIDE 0x180U
#define DOMAIN_INFO_API_MASK_OFFSET 0x04U
#define DOMAIN_INFO_MIN_MHZ_OFFSET 0x26U
#define DOMAIN_INFO_MAX_MHZ_OFFSET 0x28U
#define GPC_DOMAIN_INDEX 0U
#define XBAR_DOMAIN_INDEX 1U
#define MCLK_DOMAIN_INDEX 2U
#define SYS_DOMAIN_INDEX 3U
#define NVD_DOMAIN_INDEX 4U
#define FREQ_OFFSET_MODE_OFFSET 0x08U
#define FREQ_OFFSET_KHZ_OFFSET 0x0cU
#define RAIL_OFFSET_BASE_OFFSET 0x10U
#define MSVDD_RAIL_INDEX 1U
#define CONTROLLABLE_DOMAIN_MASK 0x000000ffU
#define XBAR_MEASURE_DOMAIN 2U
#define SYS_MEASURE_DOMAIN 4U
#define MAX_DEMO_FREQ_OFFSET_KHZ 100000
#define MAX_DEMO_RAIL_OFFSET_UV 1000
#define MAX_DEMO_HOLD_SECONDS 30U

#define TESTED_DRIVER_VERSION "610.57.04"
#define TESTED_GPU_MODEL "NVIDIA GeForce RTX 5090"
#define TESTED_VBIOS_VERSION "98.02.2E.80.50"

struct clock_domain_desc {
    const char *name;
    uint32_t index;
    uint32_t api_mask;
    uint32_t vf_first;
    uint32_t vf_count;
};

static const struct clock_domain_desc clock_domains[] = {
    { "gpc",   0U, 0x00000001U,   0U, 127U },
    { "xbar",  1U, 0x00000002U, 127U, 127U },
    { "mclk",  2U, 0x00000010U, 254U,   5U },
    { "sys",   3U, 0x00000004U, 259U, 127U },
    { "nvd",   4U, 0x00100000U, 386U, 127U },
    { "pwr",   5U, 0x00080000U, 513U, 127U },
    { "pcie",  6U, 0x00200000U, 640U,   8U },
    { "api40", 7U, 0x00000040U,   0U,   0U },
    { "api08", 8U, 0x00000008U,   0U,   0U },
};

static const char *domain_name_from_index(uint32_t index)
{
    size_t i;
    for (i = 0; i < sizeof(clock_domains) / sizeof(clock_domains[0]); ++i) {
        if (clock_domains[i].index == index)
            return clock_domains[i].name;
    }
    return "unknown";
}

static const struct clock_domain_desc *domain_from_index(uint32_t index)
{
    size_t i;
    for (i = 0; i < sizeof(clock_domains) / sizeof(clock_domains[0]); ++i) {
        if (clock_domains[i].index == index)
            return &clock_domains[i];
    }
    return NULL;
}

static int verified_rail_pair(uint32_t domain_index, uint32_t rail_index)
{
    return (domain_index == GPC_DOMAIN_INDEX && rail_index == 0U) ||
           ((domain_index == XBAR_DOMAIN_INDEX ||
             domain_index == SYS_DOMAIN_INDEX ||
             domain_index == NVD_DOMAIN_INDEX) && rail_index == 1U);
}

static char *trim_ascii(char *text)
{
    char *end;
    while (*text == ' ' || *text == '\t')
        ++text;
    end = text + strlen(text);
    while (end > text &&
           (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r' ||
            end[-1] == '\n'))
        *--end = '\0';
    return text;
}

static int file_contains(const char *path, const char *needle)
{
    FILE *stream = fopen(path, "r");
    char line[1024];
    int found = 0;
    if (stream == NULL) {
        fprintf(stderr, "open %s: %s\n", path, strerror(errno));
        return -1;
    }
    while (fgets(line, sizeof(line), stream) != NULL) {
        if (strstr(line, needle) != NULL) {
            found = 1;
            break;
        }
    }
    fclose(stream);
    return found;
}

static int validate_runtime_identity(void)
{
    glob_t matches;
    size_t i;
    int version_match;
    int identity_match = 0;

    version_match = file_contains("/proc/driver/nvidia/version",
                                  TESTED_DRIVER_VERSION);
    if (version_match <= 0) {
        fprintf(stderr,
                "refusing private ABI: expected NVIDIA driver %s\n",
                TESTED_DRIVER_VERSION);
        return -1;
    }
    memset(&matches, 0, sizeof(matches));
    if (glob("/proc/driver/nvidia/gpus/*/information", 0, NULL, &matches) !=
        0) {
        fprintf(stderr, "cannot enumerate NVIDIA GPU identity files\n");
        return -1;
    }
    for (i = 0; i < matches.gl_pathc; ++i) {
        FILE *stream = fopen(matches.gl_pathv[i], "r");
        char *line = NULL;
        size_t capacity = 0;
        char model[128] = "";
        char vbios[128] = "";
        unsigned long minor = ULONG_MAX;
        if (stream == NULL)
            continue;
        while (getline(&line, &capacity, stream) >= 0) {
            char *value;
            if (strncmp(line, "Model:", 6) == 0) {
                value = trim_ascii(line + 6);
                (void)snprintf(model, sizeof(model), "%s", value);
            } else if (strncmp(line, "Video BIOS:", 11) == 0) {
                value = trim_ascii(line + 11);
                (void)snprintf(vbios, sizeof(vbios), "%s", value);
            } else if (strncmp(line, "Device Minor:", 13) == 0) {
                char *end = NULL;
                value = trim_ascii(line + 13);
                errno = 0;
                minor = strtoul(value, &end, 10);
                if (errno != 0 || end == value)
                    minor = ULONG_MAX;
            }
        }
        free(line);
        fclose(stream);
        if (minor == 0 && strcmp(model, TESTED_GPU_MODEL) == 0 &&
            strcasecmp(vbios, TESTED_VBIOS_VERSION) == 0) {
            identity_match = 1;
            break;
        }
    }
    globfree(&matches);
    if (!identity_match) {
        fprintf(stderr,
                "refusing private ABI: /dev/nvidia0 must be %s, VBIOS %s\n",
                TESTED_GPU_MODEL, TESTED_VBIOS_VERSION);
        return -1;
    }
    printf("runtime identity: driver=%s gpu=%s vbios=%s\n",
           TESTED_DRIVER_VERSION, TESTED_GPU_MODEL, TESTED_VBIOS_VERSION);
    return 0;
}

typedef uint32_t NvHandle;
typedef struct { int ctl_fd; } nv_ioctl_register_fd_t;

typedef struct {
    NvHandle hRoot;
    NvHandle hObjectParent;
    NvHandle hObjectOld;
    uint32_t status;
} NVOS00_PARAMETERS;

typedef struct {
    NvHandle hRoot;
    NvHandle hObjectParent;
    NvHandle hObjectNew;
    uint32_t hClass;
    uint64_t pAllocParms __attribute__((aligned(8)));
    uint32_t paramsSize;
    uint32_t status;
} NVOS21_PARAMETERS;

typedef struct {
    NvHandle hClient;
    NvHandle hObject;
    uint32_t cmd;
    uint32_t flags;
    uint64_t params __attribute__((aligned(8)));
    uint32_t paramsSize;
    uint32_t status;
} NVOS54_PARAMETERS;

typedef struct {
    uint32_t deviceId;
    NvHandle hClientShare;
    NvHandle hTargetClient;
    NvHandle hTargetDevice;
    uint32_t flags;
    uint64_t vaSpaceSize __attribute__((aligned(8)));
    uint64_t vaStartInternal __attribute__((aligned(8)));
    uint64_t vaLimitInternal __attribute__((aligned(8)));
    uint32_t vaMode;
} NV0080_ALLOC_PARAMETERS;

typedef struct { uint32_t subDeviceId; } NV2080_ALLOC_PARAMETERS;

_Static_assert(sizeof(NVOS00_PARAMETERS) == 16, "NVOS00 ABI mismatch");
_Static_assert(sizeof(NVOS21_PARAMETERS) == 32, "NVOS21 ABI mismatch");
_Static_assert(sizeof(NVOS54_PARAMETERS) == 32, "NVOS54 ABI mismatch");
_Static_assert(sizeof(NV0080_ALLOC_PARAMETERS) == 56,
               "NV0080 ABI mismatch");

static volatile sig_atomic_t stop_requested;

static void request_stop(int signo)
{
    (void)signo;
    stop_requested = 1;
}

static int rm_alloc(int fd, NVOS21_PARAMETERS *p)
{
    if (ioctl(fd, _IOWR(NV_IOCTL_MAGIC, NV_ESC_RM_ALLOC,
                        NVOS21_PARAMETERS), p) < 0) {
        fprintf(stderr, "NV_ESC_RM_ALLOC: %s\n", strerror(errno));
        return -1;
    }
    if (p->status != 0) {
        fprintf(stderr, "NV_ESC_RM_ALLOC status=0x%08x\n", p->status);
        return -1;
    }
    return 0;
}

static void rm_free_root(int fd, NvHandle client)
{
    if (fd < 0 || client == 0)
        return;
    NVOS00_PARAMETERS p = {
        .hRoot = client,
        .hObjectParent = client,
        .hObjectOld = client,
    };
    (void)ioctl(fd, _IOWR(NV_IOCTL_MAGIC, NV_ESC_RM_FREE,
                          NVOS00_PARAMETERS), &p);
}

static int rm_control(int fd, NvHandle client, NvHandle object,
                      uint32_t cmd, void *params, uint32_t size,
                      uint32_t *rm_status)
{
    NVOS54_PARAMETERS control = {
        .hClient = client,
        .hObject = object,
        .cmd = cmd,
        .params = (uintptr_t)params,
        .paramsSize = size,
    };
    if (ioctl(fd, _IOWR(NV_IOCTL_MAGIC, NV_ESC_RM_CONTROL,
                        NVOS54_PARAMETERS), &control) < 0) {
        fprintf(stderr, "RM control 0x%08x: %s\n", cmd, strerror(errno));
        return -1;
    }
    *rm_status = control.status;
    return 0;
}

static uint32_t load_u32(const uint8_t *buffer, size_t offset)
{
    uint32_t value;
    memcpy(&value, buffer + offset, sizeof(value));
    return value;
}

static int16_t load_i16(const uint8_t *buffer, size_t offset)
{
    int16_t value;
    memcpy(&value, buffer + offset, sizeof(value));
    return value;
}

static size_t first_mismatch(const uint8_t *expected, const uint8_t *actual,
                             size_t size)
{
    size_t i;
    for (i = 0; i < size; ++i) {
        if (expected[i] != actual[i])
            return i;
    }
    return size;
}

static int get_info(int fd, NvHandle client, NvHandle subdevice,
                    uint8_t info[CLK_DOMAINS_INFO_SIZE])
{
    uint32_t status = 0;
    memset(info, 0, CLK_DOMAINS_INFO_SIZE);
    if (rm_control(fd, client, subdevice, CLK_DOMAINS_GET_INFO,
                   info, CLK_DOMAINS_INFO_SIZE, &status) != 0)
        return -1;
    if (status != 0) {
        fprintf(stderr, "GET_INFO status=0x%08x\n", status);
        return -1;
    }
    return 0;
}

static int validate_info_domain(const uint8_t info[CLK_DOMAINS_INFO_SIZE],
                                const struct clock_domain_desc *domain,
                                int16_t *min_mhz, int16_t *max_mhz)
{
    const uint32_t active_mask = load_u32(info, 4U);
    const size_t base = DOMAIN_INFO_HEADER_SIZE +
                        (size_t)domain->index * DOMAIN_INFO_STRIDE;
    const uint32_t api_mask = load_u32(info,
                                      base + DOMAIN_INFO_API_MASK_OFFSET);
    if (domain->index >= 32U ||
        (active_mask & (UINT32_C(1) << domain->index)) == 0) {
        fprintf(stderr, "INFO does not advertise %s record %u\n",
                domain->name, domain->index);
        return -1;
    }
    if (api_mask != domain->api_mask) {
        fprintf(stderr,
                "INFO layout mismatch for %s: api=0x%08" PRIx32
                " expected=0x%08" PRIx32 "\n",
                domain->name, api_mask, domain->api_mask);
        return -1;
    }
    *min_mhz = load_i16(info, base + DOMAIN_INFO_MIN_MHZ_OFFSET);
    *max_mhz = load_i16(info, base + DOMAIN_INFO_MAX_MHZ_OFFSET);
    printf("INFO %s: min_offset=%" PRId16 " MHz max_offset=%" PRId16
           " MHz\n", domain->name, *min_mhz, *max_mhz);
    return 0;
}

static int validate_frequency_request(const char *name, int32_t requested_khz,
                                      int16_t min_mhz, int16_t max_mhz)
{
    const int64_t requested = requested_khz;
    const int64_t minimum = (int64_t)min_mhz * 1000;
    const int64_t maximum = (int64_t)max_mhz * 1000;
    if (min_mhz == 0 && max_mhz == 0) {
        fprintf(stderr,
                "refusing %s write: INFO advertises no offset range\n", name);
        return -1;
    }
    if (requested < minimum || requested > maximum) {
        fprintf(stderr,
                "refusing %s offset=%" PRId32
                " kHz: INFO range is %" PRId64 "..%" PRId64 " kHz\n",
                name, requested_khz, minimum, maximum);
        return -1;
    }
    if (requested < -MAX_DEMO_FREQ_OFFSET_KHZ ||
        requested > MAX_DEMO_FREQ_OFFSET_KHZ) {
        fprintf(stderr,
                "refusing %s offset=%" PRId32
                " kHz: this public demo is limited to +/-%d kHz even when "
                "INFO advertises more\n",
                name, requested_khz, MAX_DEMO_FREQ_OFFSET_KHZ);
        return -1;
    }
    return 0;
}

static void vf_mask_set(uint8_t *buffer, uint32_t index)
{
    const size_t offset = VF_PRIMARY_MASK_OFFSET +
                          (size_t)(index / 32U) * sizeof(uint32_t);
    uint32_t word = load_u32(buffer, offset);
    word |= UINT32_C(1) << (index % 32U);
    memcpy(buffer + offset, &word, sizeof(word));
}

static void vf_mask_set_domain(uint8_t *buffer,
                               const struct clock_domain_desc *domain)
{
    uint32_t index;
    for (index = domain->vf_first;
         index < domain->vf_first + domain->vf_count; ++index)
        vf_mask_set(buffer, index);
}

static int get_vf_status(int fd, NvHandle client, NvHandle subdevice,
                         uint8_t status_buffer[CLK_VF_POINTS_STATUS_SIZE],
                         const struct clock_domain_desc *first,
                         const struct clock_domain_desc *second)
{
    uint32_t status = 0;
    memset(status_buffer, 0, CLK_VF_POINTS_STATUS_SIZE);
    vf_mask_set_domain(status_buffer, first);
    if (second != NULL)
        vf_mask_set_domain(status_buffer, second);
    if (rm_control(fd, client, subdevice, CLK_VF_POINTS_GET_STATUS,
                   status_buffer, CLK_VF_POINTS_STATUS_SIZE, &status) != 0)
        return -1;
    if (status != 0) {
        fprintf(stderr, "GET_VF_STATUS status=0x%08x\n", status);
        return -1;
    }
    return 0;
}

static size_t vf_status_changed_records(
    const uint8_t before[CLK_VF_POINTS_STATUS_SIZE],
    const uint8_t after[CLK_VF_POINTS_STATUS_SIZE],
    const struct clock_domain_desc *domain)
{
    uint32_t index;
    size_t changed = 0;
    for (index = domain->vf_first;
         index < domain->vf_first + domain->vf_count; ++index) {
        const size_t offset = VF_STATUS_RECORD_BASE +
                              (size_t)index * VF_STATUS_RECORD_STRIDE;
        changed += memcmp(before + offset, after + offset,
                          VF_STATUS_RECORD_STRIDE) != 0;
    }
    return changed;
}

static int compare_vf_status_records(
    const uint8_t expected[CLK_VF_POINTS_STATUS_SIZE],
    const uint8_t actual[CLK_VF_POINTS_STATUS_SIZE],
    const struct clock_domain_desc *domain)
{
    uint32_t index;
    for (index = domain->vf_first;
         index < domain->vf_first + domain->vf_count; ++index) {
        const size_t offset = VF_STATUS_RECORD_BASE +
                              (size_t)index * VF_STATUS_RECORD_STRIDE;
        const size_t mismatch = first_mismatch(expected + offset,
                                               actual + offset,
                                               VF_STATUS_RECORD_STRIDE);
        if (mismatch != VF_STATUS_RECORD_STRIDE) {
            fprintf(stderr,
                    "VF STATUS restore mismatch: %s flat=%u record+0x%zx"
                    " expected=0x%02x actual=0x%02x\n",
                    domain->name, index, mismatch,
                    expected[offset + mismatch], actual[offset + mismatch]);
            return -1;
        }
    }
    return 0;
}

static int get_control(int fd, NvHandle client, NvHandle subdevice,
                       uint8_t control[CLK_DOMAINS_CONTROL_SIZE])
{
    uint32_t status = 0;
    memset(control, 0, CLK_DOMAINS_CONTROL_SIZE);
    memcpy(control + 4, &(uint32_t){ CONTROLLABLE_DOMAIN_MASK }, 4);
    if (rm_control(fd, client, subdevice, CLK_DOMAINS_GET_CONTROL,
                   control, CLK_DOMAINS_CONTROL_SIZE, &status) != 0)
        return -1;
    if (status != 0) {
        fprintf(stderr, "GET_CONTROL status=0x%08x\n", status);
        return -1;
    }
    if (load_u32(control, 4U) != CONTROLLABLE_DOMAIN_MASK) {
        fprintf(stderr,
                "GET_CONTROL mask/layout mismatch: got 0x%08" PRIx32
                " expected 0x%08x\n",
                load_u32(control, 4U), CONTROLLABLE_DOMAIN_MASK);
        return -1;
    }
    return 0;
}

static int set_control(int fd, NvHandle client, NvHandle subdevice,
                       uint8_t control[CLK_DOMAINS_CONTROL_SIZE])
{
    uint32_t status = 0;
    if (rm_control(fd, client, subdevice, CLK_DOMAINS_SET_CONTROL,
                   control, CLK_DOMAINS_CONTROL_SIZE, &status) != 0)
        return -1;
    printf("SET_CONTROL status=0x%08x\n", status);
    return status == 0 ? 0 : -1;
}

static size_t domain_base(uint32_t domain_index)
{
    return DOMAIN_HEADER_SIZE + domain_index * DOMAIN_STRIDE;
}

static int measure_clock(int fd, NvHandle client, NvHandle subdevice,
                         uint32_t measure_domain, uint32_t *khz)
{
    uint32_t params[2] = { measure_domain, 0 };
    uint32_t status = 0;
    if (rm_control(fd, client, subdevice, CLK_MEASURE_FREQ,
                   params, sizeof(params), &status) != 0)
        return -1;
    if (status != 0) {
        fprintf(stderr, "CLK_MEASURE_FREQ status=0x%08x\n", status);
        return -1;
    }
    *khz = params[1];
    return 0;
}

static int parse_i32(const char *text, int32_t *value)
{
    char *end = NULL;
    errno = 0;
    long parsed = strtol(text, &end, 0);
    if (errno != 0 || end == text || *end != '\0' ||
        parsed < INT32_MIN || parsed > INT32_MAX)
        return -1;
    *value = (int32_t)parsed;
    return 0;
}

static void print_state(const uint8_t control[CLK_DOMAINS_CONTROL_SIZE],
                        uint32_t domain_index, const char *domain_name,
                        uint32_t measured_khz, int print_rail,
                        uint32_t rail_domain_index, uint32_t rail_index,
                        const char *rail_name)
{
    const size_t base = domain_base(domain_index);
    const size_t freq_field = base + FREQ_OFFSET_KHZ_OFFSET;
    const size_t rail_field = domain_base(rail_domain_index) +
                              RAIL_OFFSET_BASE_OFFSET +
                              rail_index * sizeof(int32_t);
    int32_t freq_offset = 0;
    int32_t rail_offset = 0;
    const char *rail_domain_name = domain_name_from_index(rail_domain_index);
    memcpy(&freq_offset, control + freq_field, 4);
    memcpy(&rail_offset, control + rail_field, 4);
    printf("%s_offset_khz=%" PRId32, domain_name, freq_offset);
    if (print_rail)
        printf(" %s_%s_offset_uv=%" PRId32,
               rail_domain_name, rail_name, rail_offset);
    printf(" measured_%s_khz=%" PRIu32 "\n", domain_name, measured_khz);
}

int main(int argc, char **argv)
{
    int rc = EXIT_FAILURE;
    int ctl = -1, card = -1;
    int write_mode = 0, applied = 0, combined_sys_xbar = 0;
    int rail_only_mode = 0;
    int32_t requested_freq = 0, requested_xbar_freq = 0;
    int32_t requested_msvdd = 0;
    unsigned int hold_seconds = 0;
    uint32_t selected_domain_index = XBAR_DOMAIN_INDEX;
    uint32_t selected_rail_domain_index = XBAR_DOMAIN_INDEX;
    uint32_t selected_rail_index = MSVDD_RAIL_INDEX;
    uint32_t selected_measure_domain = XBAR_MEASURE_DOMAIN;
    const char *selected_domain_name = "xbar";
    const char *selected_rail_name = "msvdd";
    const struct clock_domain_desc *selected_domain = NULL;
    const struct clock_domain_desc *second_status_domain = NULL;
    int selected_has_rail = 1;
    NvHandle client = 0, subdevice_handle = 0;
    uint8_t info[CLK_DOMAINS_INFO_SIZE];
    uint8_t before[CLK_DOMAINS_CONTROL_SIZE];
    uint8_t requested_control[CLK_DOMAINS_CONTROL_SIZE];
    uint8_t current[CLK_DOMAINS_CONTROL_SIZE];
    uint8_t *status_before = NULL;
    uint8_t *status_current = NULL;

    if (argc == 6 && strcmp(argv[1], "--domain-rail") == 0) {
        const struct clock_domain_desc *selected = NULL;
        char *end = NULL;
        unsigned long rail, hold;
        size_t i;
        for (i = 0; i < sizeof(clock_domains) / sizeof(clock_domains[0]); ++i) {
            if (strcasecmp(argv[2], clock_domains[i].name) == 0) {
                selected = &clock_domains[i];
                break;
            }
        }
        if (selected == NULL || selected->index >= 8U) {
            fprintf(stderr, "unknown or unavailable clock domain: %s\n", argv[2]);
            return EXIT_FAILURE;
        }
        errno = 0;
        rail = strtoul(argv[3], &end, 0);
        if (errno != 0 || end == argv[3] || *end != '\0' || rail > 1U) {
            fprintf(stderr, "rail must be 0 (NVVDD) or 1 (MSVDD)\n");
            return EXIT_FAILURE;
        }
        if (parse_i32(argv[4], &requested_msvdd) != 0) {
            fprintf(stderr, "invalid signed rail offset\n");
            return EXIT_FAILURE;
        }
        if (requested_msvdd < -MAX_DEMO_RAIL_OFFSET_UV ||
            requested_msvdd > MAX_DEMO_RAIL_OFFSET_UV) {
            fprintf(stderr,
                    "demo rail requests are limited to +/-%d uV\n",
                    MAX_DEMO_RAIL_OFFSET_UV);
            return EXIT_FAILURE;
        }
        errno = 0;
        hold = strtoul(argv[5], &end, 0);
        if (errno != 0 || end == argv[5] || *end != '\0' ||
            hold > MAX_DEMO_HOLD_SECONDS) {
            fprintf(stderr, "hold duration must be 0..%u seconds\n",
                    MAX_DEMO_HOLD_SECONDS);
            return EXIT_FAILURE;
        }
        selected_domain_index = selected->index;
        selected_rail_domain_index = selected->index;
        selected_measure_domain = selected->api_mask;
        selected_domain_name = selected->name;
        selected_rail_index = (uint32_t)rail;
        selected_rail_name = rail == 0U ? "nvvdd" : "msvdd";
        if (!verified_rail_pair(selected_domain_index,
                                selected_rail_index)) {
            fprintf(stderr,
                    "refusing unverified rail pair: %s x rail %lu\n",
                    selected_domain_name, rail);
            return EXIT_FAILURE;
        }
        selected_has_rail = 1;
        rail_only_mode = 1;
        hold_seconds = (unsigned int)hold;
        write_mode = 1;
    } else if ((argc == 3 || argc == 5) && strcmp(argv[1], "--domain") == 0) {
        const struct clock_domain_desc *selected = NULL;
        size_t i;
        for (i = 0; i < sizeof(clock_domains) / sizeof(clock_domains[0]); ++i) {
            if (strcasecmp(argv[2], clock_domains[i].name) == 0) {
                selected = &clock_domains[i];
                break;
            }
        }
        if (selected == NULL) {
            fprintf(stderr, "unknown clock domain: %s\n", argv[2]);
            return EXIT_FAILURE;
        }
        selected_domain_index = selected->index;
        selected_measure_domain = selected->api_mask;
        selected_domain_name = selected->name;
        selected_has_rail = 0;
        if (argc == 5) {
            char *end = NULL;
            unsigned long hold;
            if (selected->index >= 8U) {
                fprintf(stderr, "%s is not present in the 0xff control mask\n",
                        selected->name);
                return EXIT_FAILURE;
            }
            if (parse_i32(argv[3], &requested_freq) != 0) {
                fprintf(stderr, "invalid signed frequency offset\n");
                return EXIT_FAILURE;
            }
            errno = 0;
            hold = strtoul(argv[4], &end, 0);
            if (errno != 0 || end == argv[4] || *end != '\0' ||
                hold > MAX_DEMO_HOLD_SECONDS) {
                fprintf(stderr, "hold duration must be 0..%u seconds\n",
                        MAX_DEMO_HOLD_SECONDS);
                return EXIT_FAILURE;
            }
            hold_seconds = (unsigned int)hold;
            write_mode = 1;
        }
    } else if (argc == 6 && strcmp(argv[1], "--sys-xbar") == 0) {
        char *end = NULL;
        unsigned long hold;
        if (parse_i32(argv[2], &requested_freq) != 0 ||
            parse_i32(argv[3], &requested_xbar_freq) != 0 ||
            parse_i32(argv[4], &requested_msvdd) != 0) {
            fprintf(stderr, "invalid signed SYS/XBAR/MSVDD offset\n");
            return EXIT_FAILURE;
        }
        errno = 0;
        hold = strtoul(argv[5], &end, 0);
        if (errno != 0 || end == argv[5] || *end != '\0' ||
            hold > MAX_DEMO_HOLD_SECONDS) {
            fprintf(stderr, "hold duration must be 0..%u seconds\n",
                    MAX_DEMO_HOLD_SECONDS);
            return EXIT_FAILURE;
        }
        selected_domain_index = SYS_DOMAIN_INDEX;
        selected_rail_domain_index = XBAR_DOMAIN_INDEX;
        selected_measure_domain = SYS_MEASURE_DOMAIN;
        selected_domain_name = "sys";
        selected_has_rail = 1;
        combined_sys_xbar = 1;
        hold_seconds = (unsigned int)hold;
        write_mode = 1;
    } else if ((argc == 4 || argc == 5) && strcmp(argv[1], "--sys") == 0) {
        char *end = NULL;
        unsigned long hold;
        if (parse_i32(argv[2], &requested_freq) != 0) {
            fprintf(stderr, "invalid signed SYS offset\n");
            return EXIT_FAILURE;
        }
        if (argc == 5 && parse_i32(argv[3], &requested_msvdd) != 0) {
            fprintf(stderr, "invalid signed MSVDD offset\n");
            return EXIT_FAILURE;
        }
        errno = 0;
        hold = strtoul(argv[argc - 1], &end, 0);
        if (errno != 0 || end == argv[argc - 1] || *end != '\0' ||
            hold > MAX_DEMO_HOLD_SECONDS) {
            fprintf(stderr, "hold duration must be 0..%u seconds\n",
                    MAX_DEMO_HOLD_SECONDS);
            return EXIT_FAILURE;
        }
        selected_domain_index = SYS_DOMAIN_INDEX;
        selected_rail_domain_index = SYS_DOMAIN_INDEX;
        selected_measure_domain = SYS_MEASURE_DOMAIN;
        selected_domain_name = "sys";
        selected_has_rail = argc == 5;
        hold_seconds = (unsigned int)hold;
        write_mode = 1;
    } else if (argc == 2 && strcmp(argv[1], "--sys") == 0) {
        selected_domain_index = SYS_DOMAIN_INDEX;
        selected_measure_domain = SYS_MEASURE_DOMAIN;
        selected_domain_name = "sys";
        selected_has_rail = 0;
    } else if (argc == 4) {
        char *end = NULL;
        unsigned long hold;
        if (parse_i32(argv[1], &requested_freq) != 0 ||
            parse_i32(argv[2], &requested_msvdd) != 0) {
            fprintf(stderr, "invalid signed offset\n");
            return EXIT_FAILURE;
        }
        errno = 0;
        hold = strtoul(argv[3], &end, 0);
        if (errno != 0 || end == argv[3] || *end != '\0' ||
            hold > MAX_DEMO_HOLD_SECONDS) {
            fprintf(stderr, "hold duration must be 0..%u seconds\n",
                    MAX_DEMO_HOLD_SECONDS);
            return EXIT_FAILURE;
        }
        hold_seconds = (unsigned int)hold;
        write_mode = 1;
    } else if (argc != 1) {
        fprintf(stderr,
                "usage: %s [XBAR_OFFSET_KHZ MSVDD_OFFSET_UV SECONDS]\n"
                "       %s --sys [SYS_OFFSET_KHZ [MSVDD_OFFSET_UV] SECONDS]\n",
                argv[0],
                argv[0]);
        fprintf(stderr,
                "       %s --sys-xbar SYS_OFFSET_KHZ XBAR_OFFSET_KHZ "
                "MSVDD_OFFSET_UV SECONDS\n",
                argv[0]);
        fprintf(stderr,
                "       %s --domain NAME [OFFSET_KHZ SECONDS]\n",
                argv[0]);
        fprintf(stderr,
                "       %s --domain-rail NAME RAIL OFFSET_UV SECONDS\n",
                argv[0]);
        return EXIT_FAILURE;
    }

    if (requested_msvdd < -MAX_DEMO_RAIL_OFFSET_UV ||
        requested_msvdd > MAX_DEMO_RAIL_OFFSET_UV) {
        fprintf(stderr,
                "demo rail requests are limited to +/-%d uV\n",
                MAX_DEMO_RAIL_OFFSET_UV);
        return EXIT_FAILURE;
    }

    selected_domain = domain_from_index(selected_domain_index);
    if (selected_domain == NULL) {
        fprintf(stderr, "internal domain selection error\n");
        return EXIT_FAILURE;
    }
    if (combined_sys_xbar)
        second_status_domain = domain_from_index(XBAR_DOMAIN_INDEX);
    if (write_mode && selected_domain->vf_count == 0U) {
        fprintf(stderr, "refusing %s write: no verified STATUS bank\n",
                selected_domain->name);
        return EXIT_FAILURE;
    }

    if (validate_runtime_identity() != 0)
        return EXIT_FAILURE;

    signal(SIGINT, request_stop);
    signal(SIGTERM, request_stop);

    ctl = open("/dev/nvidiactl", O_RDWR | O_CLOEXEC);
    card = open("/dev/nvidia0", O_RDWR | O_CLOEXEC);
    if (ctl < 0 || card < 0) {
        fprintf(stderr, "open NVIDIA device: %s\n", strerror(errno));
        goto out;
    }

    nv_ioctl_register_fd_t regfd = { .ctl_fd = ctl };
    if (ioctl(card, _IOWR(NV_IOCTL_MAGIC, NV_ESC_REGISTER_FD,
                          nv_ioctl_register_fd_t), &regfd) < 0) {
        fprintf(stderr, "NV_ESC_REGISTER_FD: %s\n", strerror(errno));
        goto out;
    }

    NVOS21_PARAMETERS root = { .hClass = NV01_ROOT };
    if (rm_alloc(ctl, &root) != 0)
        goto out;
    client = root.hObjectNew;

    NV0080_ALLOC_PARAMETERS device_params = { .deviceId = 0 };
    NVOS21_PARAMETERS device = {
        .hRoot = client,
        .hObjectParent = client,
        .hClass = NV01_DEVICE_0,
        .pAllocParms = (uintptr_t)&device_params,
        .paramsSize = sizeof(device_params),
    };
    if (rm_alloc(ctl, &device) != 0)
        goto out;

    NV2080_ALLOC_PARAMETERS subdevice_params = { .subDeviceId = 0 };
    NVOS21_PARAMETERS subdevice = {
        .hRoot = client,
        .hObjectParent = device.hObjectNew,
        .hClass = NV20_SUBDEVICE_0,
        .pAllocParms = (uintptr_t)&subdevice_params,
        .paramsSize = sizeof(subdevice_params),
    };
    if (rm_alloc(ctl, &subdevice) != 0)
        goto out;
    subdevice_handle = subdevice.hObjectNew;

    if (get_info(ctl, client, subdevice_handle, info) != 0)
        goto out;
    int16_t selected_min_mhz = 0, selected_max_mhz = 0;
    if (validate_info_domain(info, selected_domain,
                             &selected_min_mhz, &selected_max_mhz) != 0)
        goto out;
    if (write_mode && !rail_only_mode &&
        validate_frequency_request(selected_domain_name, requested_freq,
                                   selected_min_mhz,
                                   selected_max_mhz) != 0)
        goto out;
    if (combined_sys_xbar) {
        int16_t xbar_min_mhz = 0, xbar_max_mhz = 0;
        if (validate_info_domain(info, second_status_domain,
                                 &xbar_min_mhz, &xbar_max_mhz) != 0 ||
            validate_frequency_request("xbar", requested_xbar_freq,
                                       xbar_min_mhz,
                                       xbar_max_mhz) != 0)
            goto out;
    }
    if (write_mode && selected_has_rail &&
        !verified_rail_pair(selected_rail_domain_index,
                            selected_rail_index)) {
        fprintf(stderr,
                "refusing unverified rail write: %s x rail %u\n",
                domain_name_from_index(selected_rail_domain_index),
                selected_rail_index);
        goto out;
    }

    if (get_control(ctl, client, subdevice_handle, before) != 0)
        goto out;

    uint32_t measured = 0;
    (void)measure_clock(ctl, client, subdevice_handle,
                        selected_measure_domain, &measured);
    printf("before: ");
    print_state(before, selected_domain_index, selected_domain_name,
                measured, selected_has_rail, selected_rail_domain_index,
                selected_rail_index, selected_rail_name);
    if (combined_sys_xbar) {
        uint32_t measured_xbar = 0;
        (void)measure_clock(ctl, client, subdevice_handle,
                            XBAR_MEASURE_DOMAIN, &measured_xbar);
        printf("before-xbar: ");
        print_state(before, XBAR_DOMAIN_INDEX, "xbar", measured_xbar, 1,
                    XBAR_DOMAIN_INDEX, MSVDD_RAIL_INDEX, "msvdd");
    }

    if (!write_mode) {
        rc = EXIT_SUCCESS;
        goto out;
    }

    status_before = calloc(1, CLK_VF_POINTS_STATUS_SIZE);
    status_current = calloc(1, CLK_VF_POINTS_STATUS_SIZE);
    if (status_before == NULL || status_current == NULL) {
        fprintf(stderr, "STATUS allocation failed: %s\n", strerror(errno));
        goto out;
    }
    if (get_vf_status(ctl, client, subdevice_handle, status_before,
                      selected_domain, second_status_domain) != 0)
        goto out;

    memcpy(current, before, sizeof(current));
    const size_t selected_base = domain_base(selected_domain_index);
    const size_t freq_mode_field = selected_base + FREQ_OFFSET_MODE_OFFSET;
    const size_t freq_field = selected_base + FREQ_OFFSET_KHZ_OFFSET;
    const size_t rail_field = domain_base(selected_rail_domain_index) +
                              RAIL_OFFSET_BASE_OFFSET +
                              selected_rail_index * sizeof(int32_t);
    if (!rail_only_mode) {
        current[freq_mode_field] = 0;
        memcpy(current + freq_field, &requested_freq, 4);
    }
    if (combined_sys_xbar) {
        const size_t xbar_base = domain_base(XBAR_DOMAIN_INDEX);
        current[xbar_base + FREQ_OFFSET_MODE_OFFSET] = 0;
        memcpy(current + xbar_base + FREQ_OFFSET_KHZ_OFFSET,
               &requested_xbar_freq, 4);
    }
    if (selected_has_rail)
        memcpy(current + rail_field, &requested_msvdd, 4);
    memcpy(requested_control, current, sizeof(requested_control));
    applied = 1;
    if (set_control(ctl, client, subdevice_handle, requested_control) != 0)
        goto out;

    if (get_control(ctl, client, subdevice_handle, current) != 0)
        goto out;
    size_t mismatch = first_mismatch(requested_control, current,
                                     CLK_DOMAINS_CONTROL_SIZE);
    if (mismatch != CLK_DOMAINS_CONTROL_SIZE) {
        fprintf(stderr,
                "full GET_CONTROL mismatch at 0x%zx: requested=0x%02x "
                "readback=0x%02x\n",
                mismatch, requested_control[mismatch], current[mismatch]);
        goto out;
    }
    printf("readback: full 0x%x-byte control object is byte-identical\n",
           CLK_DOMAINS_CONTROL_SIZE);
    if (get_vf_status(ctl, client, subdevice_handle, status_current,
                      selected_domain, second_status_domain) != 0)
        goto out;
    printf("STATUS changed records: %s=%zu/%u",
           selected_domain->name,
           vf_status_changed_records(status_before, status_current,
                                     selected_domain),
           selected_domain->vf_count);
    if (second_status_domain != NULL) {
        printf(" %s=%zu/%u", second_status_domain->name,
               vf_status_changed_records(status_before, status_current,
                                         second_status_domain),
               second_status_domain->vf_count);
    }
    printf(" (adoption observation, not physical-rail proof)\n");
    (void)measure_clock(ctl, client, subdevice_handle,
                        selected_measure_domain, &measured);
    printf("readback: ");
    print_state(current, selected_domain_index, selected_domain_name,
                measured, selected_has_rail, selected_rail_domain_index,
                selected_rail_index, selected_rail_name);
    if (combined_sys_xbar) {
        uint32_t measured_xbar = 0;
        (void)measure_clock(ctl, client, subdevice_handle,
                            XBAR_MEASURE_DOMAIN, &measured_xbar);
        printf("readback-xbar: ");
        print_state(current, XBAR_DOMAIN_INDEX, "xbar", measured_xbar, 1,
                    XBAR_DOMAIN_INDEX, MSVDD_RAIL_INDEX, "msvdd");
    }

    for (unsigned int i = 0; i < hold_seconds * 10U && !stop_requested; ++i) {
        usleep(100000);
        if (measure_clock(ctl, client, subdevice_handle,
                          selected_measure_domain, &measured) == 0) {
            if (combined_sys_xbar) {
                uint32_t measured_xbar = 0;
                (void)measure_clock(ctl, client, subdevice_handle,
                                    XBAR_MEASURE_DOMAIN, &measured_xbar);
                printf("sample=%u measured_sys_khz=%" PRIu32
                       " measured_xbar_khz=%" PRIu32 "\n",
                       i, measured, measured_xbar);
            } else {
                printf("sample=%u measured_%s_khz=%" PRIu32 "\n", i,
                       selected_domain_name, measured);
            }
        }
    }
    rc = EXIT_SUCCESS;

out:
    if (applied) {
        if (set_control(ctl, client, subdevice_handle, before) != 0) {
            fprintf(stderr, "restore failed\n");
            rc = EXIT_FAILURE;
        } else if (get_control(ctl, client, subdevice_handle, current) != 0) {
            rc = EXIT_FAILURE;
        } else {
            uint32_t measured = 0;
            (void)measure_clock(ctl, client, subdevice_handle,
                                selected_measure_domain, &measured);
            printf("restored: ");
            print_state(current, selected_domain_index,
                        selected_domain_name, measured,
                        selected_has_rail, selected_rail_domain_index,
                        selected_rail_index, selected_rail_name);
            mismatch = first_mismatch(before, current,
                                      CLK_DOMAINS_CONTROL_SIZE);
            if (mismatch != CLK_DOMAINS_CONTROL_SIZE) {
                fprintf(stderr,
                        "CONTROL restore mismatch at 0x%zx: expected=0x%02x "
                        "actual=0x%02x\n",
                        mismatch, before[mismatch], current[mismatch]);
                rc = EXIT_FAILURE;
            } else if (get_vf_status(ctl, client, subdevice_handle,
                                     status_current, selected_domain,
                                     second_status_domain) != 0 ||
                       compare_vf_status_records(status_before,
                                                 status_current,
                                                 selected_domain) != 0 ||
                       (second_status_domain != NULL &&
                        compare_vf_status_records(status_before,
                                                  status_current,
                                                  second_status_domain) != 0)) {
                rc = EXIT_FAILURE;
            } else {
                printf("restore verified: full CONTROL and selected VF STATUS "
                       "records are byte-identical\n");
            }
        }
    }
    free(status_before);
    free(status_current);
    rm_free_root(ctl, client);
    if (ctl >= 0)
        close(ctl);
    if (card >= 0)
        close(card);
    return rc;
}
