#define _GNU_SOURCE

/*
 * Minimal R610 Linux demo for NVIDIA ClockClient XBAR controls.
 *
 * Tested on RTX 5090 / 610.57.04.  The 0x83c layout is private and must not be
 * assumed to be stable across driver branches.  With no arguments this only
 * reads the current XBAR offsets and measured clock.  The write form snapshots
 * the complete control block, applies the two requested offsets, reads them
 * back, samples XBAR, then restores the original block.
 */

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
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
#define CLK_DOMAINS_GET_CONTROL 0x2080901bU
#define CLK_DOMAINS_SET_CONTROL 0x2080d01cU
#define CLK_DOMAINS_CONTROL_SIZE 0x83cU

#define DOMAIN_HEADER_SIZE 0x3cU
#define DOMAIN_STRIDE 0x40U
#define XBAR_DOMAIN_INDEX 1U
#define SYS_DOMAIN_INDEX 3U
#define FREQ_OFFSET_MODE_OFFSET 0x08U
#define FREQ_OFFSET_KHZ_OFFSET 0x0cU
#define RAIL_OFFSET_BASE_OFFSET 0x10U
#define MSVDD_RAIL_INDEX 1U
#define CONTROLLABLE_DOMAIN_MASK 0x000000ffU
#define XBAR_MEASURE_DOMAIN 2U
#define SYS_MEASURE_DOMAIN 4U

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
                        uint32_t measured_khz, int print_msvdd,
                        uint32_t msvdd_domain_index)
{
    const size_t base = domain_base(domain_index);
    const size_t freq_field = base + FREQ_OFFSET_KHZ_OFFSET;
    const size_t msvdd_field = domain_base(msvdd_domain_index) +
                                RAIL_OFFSET_BASE_OFFSET +
                                MSVDD_RAIL_INDEX * sizeof(int32_t);
    int32_t freq_offset = 0;
    int32_t msvdd_offset = 0;
    const char *msvdd_domain_name =
        msvdd_domain_index == XBAR_DOMAIN_INDEX ? "xbar" : domain_name;
    memcpy(&freq_offset, control + freq_field, 4);
    memcpy(&msvdd_offset, control + msvdd_field, 4);
    printf("%s_offset_khz=%" PRId32, domain_name, freq_offset);
    if (print_msvdd)
        printf(" %s_msvdd_offset_uv=%" PRId32,
               msvdd_domain_name, msvdd_offset);
    printf(" measured_%s_khz=%" PRIu32 "\n", domain_name, measured_khz);
}

int main(int argc, char **argv)
{
    int rc = EXIT_FAILURE;
    int ctl = -1, card = -1;
    int write_mode = 0, applied = 0, combined_sys_xbar = 0;
    int32_t requested_freq = 0, requested_xbar_freq = 0;
    int32_t requested_msvdd = 0;
    unsigned int hold_seconds = 0;
    uint32_t selected_domain_index = XBAR_DOMAIN_INDEX;
    uint32_t selected_msvdd_domain_index = XBAR_DOMAIN_INDEX;
    uint32_t selected_measure_domain = XBAR_MEASURE_DOMAIN;
    const char *selected_domain_name = "xbar";
    int selected_has_msvdd = 1;
    NvHandle client = 0, subdevice_handle = 0;
    uint8_t before[CLK_DOMAINS_CONTROL_SIZE];
    uint8_t current[CLK_DOMAINS_CONTROL_SIZE];

    if (argc == 6 && strcmp(argv[1], "--sys-xbar") == 0) {
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
            hold > 3600) {
            fprintf(stderr, "invalid hold duration\n");
            return EXIT_FAILURE;
        }
        selected_domain_index = SYS_DOMAIN_INDEX;
        selected_measure_domain = SYS_MEASURE_DOMAIN;
        selected_domain_name = "sys";
        selected_has_msvdd = 1;
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
            hold > 3600) {
            fprintf(stderr, "invalid hold duration\n");
            return EXIT_FAILURE;
        }
        selected_domain_index = SYS_DOMAIN_INDEX;
        selected_measure_domain = SYS_MEASURE_DOMAIN;
        selected_domain_name = "sys";
        selected_has_msvdd = argc == 5;
        hold_seconds = (unsigned int)hold;
        write_mode = 1;
    } else if (argc == 2 && strcmp(argv[1], "--sys") == 0) {
        selected_domain_index = SYS_DOMAIN_INDEX;
        selected_measure_domain = SYS_MEASURE_DOMAIN;
        selected_domain_name = "sys";
        selected_has_msvdd = 0;
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
            hold > 3600) {
            fprintf(stderr, "invalid hold duration\n");
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
        return EXIT_FAILURE;
    }

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

    if (get_control(ctl, client, subdevice_handle, before) != 0)
        goto out;

    uint32_t measured = 0;
    (void)measure_clock(ctl, client, subdevice_handle,
                        selected_measure_domain, &measured);
    printf("before: ");
    print_state(before, selected_domain_index, selected_domain_name,
                measured, selected_has_msvdd,
                selected_msvdd_domain_index);
    if (combined_sys_xbar) {
        uint32_t measured_xbar = 0;
        (void)measure_clock(ctl, client, subdevice_handle,
                            XBAR_MEASURE_DOMAIN, &measured_xbar);
        printf("before-xbar: ");
        print_state(before, XBAR_DOMAIN_INDEX, "xbar", measured_xbar, 1,
                    XBAR_DOMAIN_INDEX);
    }

    if (!write_mode) {
        rc = EXIT_SUCCESS;
        goto out;
    }

    memcpy(current, before, sizeof(current));
    const size_t selected_base = domain_base(selected_domain_index);
    const size_t freq_mode_field = selected_base + FREQ_OFFSET_MODE_OFFSET;
    const size_t freq_field = selected_base + FREQ_OFFSET_KHZ_OFFSET;
    const size_t msvdd_field = domain_base(selected_msvdd_domain_index) +
                                RAIL_OFFSET_BASE_OFFSET +
                                MSVDD_RAIL_INDEX * sizeof(int32_t);
    current[freq_mode_field] = 0;
    memcpy(current + freq_field, &requested_freq, 4);
    if (combined_sys_xbar) {
        const size_t xbar_base = domain_base(XBAR_DOMAIN_INDEX);
        current[xbar_base + FREQ_OFFSET_MODE_OFFSET] = 0;
        memcpy(current + xbar_base + FREQ_OFFSET_KHZ_OFFSET,
               &requested_xbar_freq, 4);
    }
    if (selected_has_msvdd)
        memcpy(current + msvdd_field, &requested_msvdd, 4);
    if (set_control(ctl, client, subdevice_handle, current) != 0)
        goto out;
    applied = 1;

    if (get_control(ctl, client, subdevice_handle, current) != 0)
        goto out;
    (void)measure_clock(ctl, client, subdevice_handle,
                        selected_measure_domain, &measured);
    printf("readback: ");
    print_state(current, selected_domain_index, selected_domain_name,
                measured, selected_has_msvdd,
                selected_msvdd_domain_index);
    if (combined_sys_xbar) {
        uint32_t measured_xbar = 0;
        (void)measure_clock(ctl, client, subdevice_handle,
                            XBAR_MEASURE_DOMAIN, &measured_xbar);
        printf("readback-xbar: ");
        print_state(current, XBAR_DOMAIN_INDEX, "xbar", measured_xbar, 1,
                    XBAR_DOMAIN_INDEX);
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
            int32_t old_freq = 0, old_msvdd = 0;
            int32_t restored_freq = 0, restored_msvdd = 0;
            memcpy(&old_freq, before + freq_field, 4);
            memcpy(&old_msvdd, before + msvdd_field, 4);
            memcpy(&restored_freq, current + freq_field, 4);
            memcpy(&restored_msvdd, current + msvdd_field, 4);
            (void)measure_clock(ctl, client, subdevice_handle,
                                selected_measure_domain, &measured);
            printf("restored: ");
            print_state(current, selected_domain_index,
                        selected_domain_name, measured,
                        selected_has_msvdd,
                        selected_msvdd_domain_index);
            int xbar_restore_mismatch = 0;
            if (combined_sys_xbar) {
                int32_t old_xbar_freq = 0, restored_xbar_freq = 0;
                const size_t xbar_freq_field =
                    domain_base(XBAR_DOMAIN_INDEX) + FREQ_OFFSET_KHZ_OFFSET;
                memcpy(&old_xbar_freq, before + xbar_freq_field, 4);
                memcpy(&restored_xbar_freq, current + xbar_freq_field, 4);
                xbar_restore_mismatch = old_xbar_freq != restored_xbar_freq;
            }
            if (old_freq != restored_freq || xbar_restore_mismatch ||
                (selected_has_msvdd && old_msvdd != restored_msvdd))
                rc = EXIT_FAILURE;
        }
    }
    rm_free_root(ctl, client);
    if (ctl >= 0)
        close(ctl);
    if (card >= 0)
        close(card);
    return rc;
}
