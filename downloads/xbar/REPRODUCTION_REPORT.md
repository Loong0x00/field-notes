# Fresh reproduction of NVIDIA/open-gpu-kernel-modules#1266

Generated: `2026-08-10T21:23:27.098467+08:00`

## Configuration

- Kernel: `Linux REDACTED-HOST 7.1.6-arch1-1 #1 SMP PREEMPT_DYNAMIC Tue, 04 Aug 2026 11:19:27 +0000 x86_64 GNU/Linux`
- NVIDIA driver: `610.57.04`
- VBIOS: `98.02.2E.C0.0F`
- GPU: `NVIDIA GeForce RTX 5090`
- Test control: identical 127-point V/F curve, +2000 MHz memory offset and 600 W power limit.
- Unlocked: `nvidia-smi --reset-memory-clocks`.
- Locked: `nvidia-smi --lock-memory-clocks=15000,16000`.
- Persistence mode was enabled during the runs, then restored.
- Adapted test config SHA-256: `f44bd358f5df03a971d969c41c5a538bbd8d626fe4236a7f25f53dcb0dbc3e09`.
- Original live config before/after SHA-256: `90b6d0dd2c635fad91313cf90b42d4155f8fc83e60465a22e31cf720abadf794` / `90b6d0dd2c635fad91313cf90b42d4155f8fc83e60465a22e31cf720abadf794`.

## Cyberpunk 2077 2.31, 6144x3456, path tracing, no frame generation

| Pair | State | avg FPS | min/max FPS | MCLK MHz | XBAR MHz | SYS MHz | GPU MHz | mV | avg board W | GPU util |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | unlocked | 11.7215 | 10.2244/13.6559 | 15001.0 | 2429.9 | 2269.4 | 2832.8 | 972.2 | 600.0 | 96.6% |
| 1 | 15000-16000 | 10.3288 | 9.4683/11.7779 | 15001.0 | 1628.8 | 1486.0 | 2956.8 | 1018.2 | 571.2 | 98.6% |
| 1 delta | locked loss | **11.88%** |  |  |  |  |  |  |  |  |
| 2 | unlocked | 11.6946 | 10.1917/13.7253 | 15001.0 | 2423.2 | 2266.1 | 2830.6 | 971.4 | 599.7 | 97.2% |
| 2 | 15000-16000 | 10.3784 | 9.4928/11.8559 | 15001.0 | 1628.8 | 1486.0 | 2956.9 | 1017.4 | 572.6 | 97.0% |
| 2 delta | locked loss | **11.25%** |  |  |  |  |  |  |  |  |

Reproduction frequency: **2/2 pairs**. Mean unlocked/locked FPS: `11.7080` / `10.3536`; loss `11.57%`.

## FurMark 2.10.2 Vulkan, 3840x2160

| Pair | State | Score | min/avg/max FPS | MCLK MHz | XBAR MHz | SYS MHz | GPU MHz | mV | avg board W |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | unlocked | 2412 | 236/242/248 | 15001.0 | 2300.3 | 2138.5 | 2411.4 | 880.7 | 582.4 |
| 1 | 15000-16000 | 1911 | 186/190/194 | 15001.0 | 1628.6 | 1486.1 | 2918.7 | 964.6 | 556.7 |
| 1 delta | locked loss |  | **21.49%** |  |  |  |  |  |  |
| 2 | unlocked | 2404 | 236/241/244 | 15001.0 | 2303.0 | 2144.1 | 2417.3 | 879.2 | 582.4 |
| 2 | 15000-16000 | 1915 | 155/189/194 | 15001.0 | 1628.4 | 1485.8 | 2915.5 | 962.1 | 559.5 |
| 2 delta | locked loss |  | **21.58%** |  |  |  |  |  |  |
| 3 | unlocked | 2404 | 231/240/244 | 15001.0 | 2302.5 | 2143.4 | 2401.6 | 878.2 | 583.2 |
| 3 | 15000-16000 | 1916 | 174/190/197 | 15001.0 | 1628.1 | 1485.6 | 2919.5 | 964.7 | 552.5 |
| 3 delta | locked loss |  | **20.83%** |  |  |  |  |  |  |

Reproduction frequency: **3/3 pairs**. Mean unlocked/locked FPS: `241.00` / `189.67`; loss `21.30%`.

In every formal run, physical MCLK remained approximately 15001 MHz. The finite, non-binding maximum nevertheless moved XBAR/SYS to the lower state. In FurMark, the reported GPU clock increased while useful rendered throughput fell.

No formal run reported thermal slowdown, hardware slowdown, power-brake slowdown, software thermal slowdown, or an active private RM PERF limit. Kernel logs contain no new NVIDIA Xid during the experiment.

## Artifact notes

- `nvidia-bug-report-unlocked.log.gz`: fresh R610 unlocked capture.
- `nvidia-bug-report-locked.log.gz`: fresh R610 capture while the public MCLK range was active.
- `nvidia-bug-report-recovered.log.gz`: fresh post-cleanup capture.
- `nvidia-bug-report-memory-lock-20260728.log.gz`: original R610.43.03 / kernel 7.1.4 report from the issue submission.
- Every benchmark directory contains raw high-rate telemetry, exact benchmark output, pre/post state, and file hashes.
- The failed U3 launch is retained separately as a harness diagnostic and is not included in performance statistics.
