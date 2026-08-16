# GB202 PTX XBAR boundary report — 2026-08-16

## Scope and identity

- GPU: NVIDIA GeForce RTX 5090, PCI `0000:01:00.0`
- Driver: `610.57.04`
- VBIOS: `98.02.2E.80.50`
- Board power limit: 800 W
- Isolated-test binary SHA-256: `f2e25984629f712665a3b5aec2fda8ff2831851af23a72134d0707706248ff4f`
- Isolated-test source SHA-256: `91bfe9ae2f79226c768d940ccde77da05f9a1b4d28344b845638716b38106fa7`
- Mixed-test binary SHA-256: `485efd578c7102b083113ccd2de04260c0a42292c477e661c9d6c042eecd7934`
- Mixed-test source SHA-256: `e8a93d1d8fc2dd459d16be2b750010e51643a24f95add25b70bb5349fb531c16`

The downloadable [PTX evidence directory](ptx-boundary-evidence/) contains the
two exact tested sources and the retained isolated/mixed sweep logs. The
original executable bytes were not retained: the two binary hashes above
identify the recorded runs, but cannot be verified against a downloadable
binary. Rebuilding the exact source did not reproduce those executable hashes;
the package therefore publishes no rebuilt binary as if it were the original.

The inline-PTX test covers all 170 SMs. It verifies register-only compute,
random L2-resident `ld.global.cg` reads, a 1 GiB VRAM transform, and exact
global-atomic counts. Mixed kernels interleave compute, L2, VRAM, and atomic
operations among resident warps. The acceptance oracles are not all equally
independent: compute output and atomic totals have host-side reference checks,
whereas L2 and VRAM use deterministic GPU-side generation and comparison.
Those two data paths detect mismatches during the run but cannot exclude a
common-mode implementation error shared by GPU-side generation and checking.

Voltage controls below are dynamic maximum targets, not fixed physical rail
voltages. RM hardware XBAR/SYS clocks, NVML state, rail targets, SM coverage,
data errors, and kernel events were recorded together.

## Confirmed 2.9 GHz baseline

Control: GPC request 2900 MHz, propagation ratio 1.000, XBAR offset +260 MHz,
dynamic NVVDD maximum 950 mV, dynamic MSVDD maximum 1150 mV.

All four 5-second workloads passed with zero data errors and zero kernel
alerts. Average XBAR was 2902.1 MHz for compute, 2899.3 MHz for L2, 2900.9 MHz
for atomics, and 2895.7 MHz for VRAM.

## Ratio is not a direct frequency equation

With the 2.9 GHz source request and offset held constant:

| Ratio | L2 XBAR min/avg/max MHz | MSVDD target avg/max mV | Result |
|---:|---:|---:|---|
| 1.015 | 2919.6 / 2934.6 / 2945.3 | 1138.6 / 1145 | pass |
| 1.030 | 2922.8 / 2942.8 / 2964.7 | 1147.0 / 1150 | pass |
| 1.045 | 2925.6 / 2941.8 / 2971.4 | 1147.3 / 1150 | pass |

The sustained average stopped increasing after 1.030 as the controller hit
the MSVDD ceiling and reduced the source bin. Separately, GPC 3000 MHz,
stock 0.899902 propagation, and XBAR +300 MHz produced only 2699.1 MHz average
XBAR. Therefore `GPC * ratio + offset` is not a physical-frequency equation.

## Physical 3 GHz boundary

Control: GPC request 3000 MHz, ratio 1.000, dynamic NVVDD maximum 980 mV,
dynamic MSVDD maximum 1065 mV.

| XBAR offset | Workload | XBAR min/avg/max MHz | Result |
|---:|---|---:|---|
| +420 | compute, 1 s | 2981.9 / 2992.1 / 3004.0 | pass |
| +430 | L2, 5 s | 2959.9 / 2974.2 / 2999.5 | pass |
| +430 | VRAM, 5 s | 2961.7 / 2972.8 / 2991.4 | pass |
| +440 | compute, 2 s | 2988.1 / 3000.1 / 3010.5 | pass |
| +440 | atomic, 3 s | 2986.3 / 2997.7 / 3006.0 | pass |
| +440 | L2, 3 s | 2965.8 / 2988.6 / 3004.6 | 1 error in 423,540,817,920 loads |

The first +440 L2 run recorded one silent mismatch without Xid, AER, GSP, or
PCIe alerts. An immediate +430 control then completed about 2616 GiB of L2 and
6723 GiB of VRAM checks without error.

The mismatch did not reproduce. Later +440 tests passed 1,412,515,758,080
isolated-L2 loads and 3,225,755,320,320 checked loads across the expanded
mixed matrix. A 15-second compute/L2/VRAM/atomic run passed 409,993,216,000
loads and exactly 12,812,288,000 atomic operations.

The best no-error mixed averages were 2997.0 MHz for L2+VRAM and 2996.2 MHz
for the 15-second four-path run. Samples crossed 3 GHz, but no verified
data-moving workload sustained an average above 3 GHz. Increasing the offset
from +430 to +440 added only about 4–5 MHz to those averages, showing strong
controller compression near the boundary.

## Evidence boundary

Confirmed: approximately 2.9 GHz across all four verified path classes; brief
samples above 3 GHz; a brief compute average of 3000.1 MHz; one recorded but
non-reproduced L2 mismatch; later multi-trillion-load clean repeats.

Not confirmed: long-term average XBAR above 3 GHz, daily stability, the
background silent-error rate, or which single controller constraint causes
the near-3-GHz compression.

All controls were restored. The completed isolated and mixed sweeps logged no
Xid, AER, GSP-health, or PCIe event and required no reboot or SBR.
