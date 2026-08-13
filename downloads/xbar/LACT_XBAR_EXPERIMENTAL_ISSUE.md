## Summary

I found working runtime controls for the XBAR clock offset and the XBAR-domain MSVDD voltage offset on NVIDIA Blackwell under Linux. Both controls can be read, written, read back exactly, measured through the hardware clock query, and restored without a reboot.

This exposes an additional clock domain that is currently not adjustable in LACT or the public NVIDIA Linux tools. It can provide measurable performance gains in workloads sensitive to the GPU crossbar/cache/memory path. The voltage control is independent from the frequency control and becomes relevant at larger XBAR offsets.

The controls were tested through the private RM ClockClient interface on an RTX 5090 with driver 610.57.04. A minimal standalone C demonstration is available here:

https://gist.github.com/Loong0x00/959d7e934366a721399a84e7943cf442

## Controls

The following R610 controls were used:

| Command | ID | Parameter size |
|---|---:|---:|
| `NV2080_CTRL_CMD_CLK_CLK_DOMAINS_GET_INFO` | `0x20809019` | `0x3030` |
| `NV2080_CTRL_CMD_CLK_CLK_DOMAINS_GET_CONTROL` | `0x2080901b` | `0x083c` |
| `NV2080_CTRL_CMD_CLK_CLK_DOMAINS_SET_CONTROL` | `0x2080d01c` | `0x083c` |
| `NV2080_CTRL_CMD_CLK_MEASURE_FREQ` | `0x20809006` | `0x0008` |

The relevant layout of the `0x83c` control block on this driver is:

```text
+0x04  controllable-domain mask (0x000000ff)

domain header: 0x3c bytes
domain stride: 0x40 bytes
XBAR domain entry: index 1, base +0x7c

+0x84  frequency-offset mode
+0x88  signed frequency offset in kHz
+0x90  signed XBAR-domain MSVDD offset in microvolts
```

`CLK_MEASURE_FREQ` domain `2` returns the physical XBAR clock in kHz. The reported XBAR frequency-offset range on this system is `-1000` to `+1000 MHz`.

This layout is private and driver-branch-specific. The result above is for R610; it should not be assumed to match R570 or future branches without checking the returned structures.

## Minimal demonstration

Build:

```bash
cc -std=gnu11 -O2 -Wall -Wextra -Wpedantic -Werror \
  xbar_clock_demo.c -o xbar_clock_demo
```

Read current state:

```bash
sudo ./xbar_clock_demo
```

Example output:

```text
before: xbar_offset_khz=0 xbar_msvdd_offset_uv=0 measured_xbar_khz=1440558
```

Apply a `+60 MHz` XBAR offset for two seconds, read it back, then restore the original control block:

```bash
sudo ./xbar_clock_demo 60000 0 2
```

Observed output:

```text
before: xbar_offset_khz=0 xbar_msvdd_offset_uv=0 measured_xbar_khz=1439616
SET_CONTROL status=0x00000000
readback: xbar_offset_khz=60000 xbar_msvdd_offset_uv=0 measured_xbar_khz=1462144
...
SET_CONTROL status=0x00000000
restored: xbar_offset_khz=0 xbar_msvdd_offset_uv=0 measured_xbar_khz=1440061
```

The same mechanism accepts both offsets in one control transaction. A `+450 MHz` XBAR request and a `+20 mV` XBAR-domain MSVDD request returned:

```text
old_xbar_offset_khz=0 requested_xbar_offset_khz=450000
old_xbar_msvdd_offset_uv=0 requested_xbar_msvdd_offset_uv=20000
set_status=0x00000000
readback_xbar_offset_khz=450000
readback_xbar_msvdd_offset_uv=20000
...
restore_set_status=0x00000000
restore_get_status=0x00000000
restored_xbar_offset_khz=0
restored_xbar_msvdd_offset_uv=0
```

## Measured performance benefit

Short FurMark 2.10.2 Vulkan runs at 3840x2160 were used to verify that the control changes useful work rather than only a reported clock. Every run used the same GPU configuration, `15001 MHz` physical MCLK and a `600 W` power limit.

| XBAR request | MSVDD request | Physical XBAR min/avg/max | FPS min/avg/max | Change in average FPS |
|---:|---:|---:|---:|---:|
| `0 MHz` | `0 mV` | 2067 / 2172 / 2444 MHz | 237 / 245 / 250 | baseline |
| `+60 MHz` | `0 mV` | 2129 / 2217 / 2508 MHz | 241 / 250 / 254 | +2.0% |
| `+120 MHz` | `0 mV` | 2189 / 2290 / 2563 MHz | 252 / 258 / 261 | +5.3% |
| `+240 MHz` | `0 mV` | 2300 / 2392 / 2688 MHz | 261 / 266 / 271 | +8.6% |
| `+300 MHz` | `0 mV` | 2318 / 2451 / 2746 MHz | 252 / 266 / 274 | +8.6% |
| `+450 MHz` | `+20 mV` | 2386 / 2538 / 2835 MHz | 260 / 271 / 277 | +10.6% |

The first five runs used 10-second scored intervals. The final combined frequency/voltage run used an 8-second scored interval, so it is evidence of control and short-run throughput rather than a stability qualification.

At `+450 MHz` with no voltage offset, the request still returned success and exact readback, but the run showed visible grey-screen corruption and long frames. Adding the independent `+20 mV` XBAR-domain MSVDD offset removed those symptoms in the short test. Applying `+20 mV` without a frequency offset reduced average FPS from approximately 245 to 237 because the extra voltage consumed power budget without increasing XBAR frequency.

This shows that:

- the XBAR frequency offset changes the physical clock and rendered throughput;
- the per-domain MSVDD offset is a separate control rather than an automatic consequence of the XBAR offset;
- successful RM status and exact readback do not imply stability;
- the useful setting is workload-, voltage- and power-budget-dependent.

The MSVDD value here is a domain request into the shared voltage-rail arbitration logic, not a guarantee that the physical rail is raised by a fixed amount at every instant.

## Hardware and software

- GPU: ASUS ROG Astral RTX 5090, GB202 A1 (`10de:2b85`, subsystem `1043:89e3`)
- VBIOS: `98.02.2E.80.50` (ASUS XOC VBIOS)
- NVIDIA driver / GSP firmware: `610.57.04`
- Kernel module: `nvidia-open-dkms 610.57.04-1`
- Kernel: `7.1.6-arch1-1`
- Distribution: Arch Linux
- GSP-RM: enabled
- Test power limit: `600 W`

The control has only been tested on this GPU and driver build so far.

## Related observations

This control also provides a direct way to investigate XBAR behavior that is otherwise hidden from public NVIDIA Linux tools. A separate Blackwell issue shows that a finite memory-clock maximum can silently constrain XBAR/SYS and substantially reduce throughput even when the memory maximum is non-binding:

- LACT-side controlled experiment: #1128
- NVIDIA report with direct XBAR/SYS measurements: https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1266

LACT already uses undocumented NVIDIA ClockClient calls for its per-point V/F editor (#936 / #957), so this is another runtime-reversible control in the same general driver subsystem.
