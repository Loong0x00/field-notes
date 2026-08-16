# GB202 SYS clock runtime control and A/B evidence

Date: 2026-08-11
GPU: NVIDIA GeForce RTX 5090
Driver: 610.57.04
Runtime VBIOS state: ASUS XOC

This is the publication copy of the SYS-specific runtime evidence used by the
article. It separates control retention, hardware frequency measurement,
performance observations, failure observations, and interpretation.

## Control interface

The private RM client-clock-domain object exposes SYS as record index 3. The
matching one-hot API and hardware-measurement mask is `0x00000004`.

```text
./xbar_clock_demo --sys
sudo ./xbar_clock_demo --sys SYS_OFFSET_KHZ HOLD_SECONDS
```

A `+300000 kHz` write returned `NV_OK`, GET_CONTROL returned the exact request,
and process termination restored the prior zero offset. Later `+450000` and
`+600000 kHz` tests used the same full-preimage/restore discipline.

## FurMark Vulkan 4K, 20 seconds

All three runs used the same existing GPU and memory settings and a 600 W board
limit.

| SYS offset | Hardware SYS avg | Hardware XBAR avg | GPU clock avg | FPS min/avg/max | Score |
|---:|---:|---:|---:|---:|---:|
| 0 MHz | 2147.1 MHz | 2170.0 MHz | 2630.4 MHz | 229 / 239 / 245 | 4791 |
| +150 MHz | 2297.7 MHz | 2159.7 MHz | 2602.0 MHz | 238 / 241 / 246 | 4824 |
| +300 MHz | 2433.8 MHz | 2166.4 MHz | 2589.8 MHz | 236 / 241 / 251 | 4814 |

The short score delta is about 0.5--0.7% and plateaus after +150 MHz. This test
alone does not separate a small real gain from run variance.

## Cyberpunk 2077 2.31, 6144x3456 path tracing

Each run used the same 972-frame built-in benchmark, with no frame generation.

| SYS offset | Average FPS | Minimum FPS | Scene time | Hardware SYS avg | Hardware XBAR avg | GPU clock avg | Board power avg |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 MHz | 11.950357 | 10.435973 | 81.3365 s | 2330.7 MHz | 2356.6 MHz | 3046.9 MHz | 589.0 W |
| +150 MHz | 12.103958 | 10.559550 | 80.3869 s | 2488.9 MHz | 2357.1 MHz | 3047.7 MHz | 591.9 W |
| +300 MHz | 12.079484 | 10.523879 | 80.4670 s | 2613.4 MHz | 2341.9 MHz | 3030.2 MHz | 592.3 W |

For +300 MHz versus baseline:

- average FPS: +1.0805%;
- minimum FPS: +0.8423%;
- scene time: -1.0680%;
- measured SYS: +12.1277%;
- measured XBAR: -0.6238%;
- reported GPU clock: -0.5481%;
- average board power: approximately +3.3 W.

This pair shows that changing SYS independently can affect this workload. The
approximately 1% number is not presented as a precise long-run gain because the
+150 and +300 results are within about 0.2% of each other.

## +600 MHz failures

SYS +600 MHz without a rail offset failed during the Cyberpunk launch/loading
path. Hardware SYS samples reached about 2.75 GHz average and 3.03 GHz maximum.
The driver then logged TLB invalidation failures, `Xid 109 CTX SWITCH TIMEOUT`,
recovery action `PF FLR`, and `Xid 8`. The display froze and the host was
rebooted.

An atomic request of SYS +600 MHz and an XBAR-record MSVDD offset of +25 mV
completed a 20-second FurMark run at 2745.2 MHz SYS average / 3033.6 MHz
maximum. The same state froze Cyberpunk again at the startup/logo path, with
telemetry stopping at 2763.2 MHz average / 3036.9 MHz maximum SYS.

Adding XBAR +450 MHz to the same SYS +600 MHz / MSVDD +25 mV state also
completed FurMark but again froze Cyberpunk. This rules out the simple claim
that a roughly 2.8 GHz XBAR or a modest logical MSVDD increase alone makes a
roughly 3.03 GHz SYS state stable.

## Ratio-preserving +450 MHz control

A more isolated control used:

```text
board limit       800 W
GPC client        max-only 2400 MHz
XBAR              automatic, zero frequency offset
MSVDD offset      zero
SYS offset        +450 MHz
```

Both the adjacent baseline and the verified +450 MHz run completed the same
972-frame Cyberpunk benchmark:

| measurement | baseline | SYS +450 | delta |
|---|---:|---:|---:|
| GPC hardware average | 2380.0 MHz | 2379.3 MHz | -0.7 MHz |
| XBAR hardware average | 2148.9 MHz | 2149.1 MHz | +0.2 MHz |
| SYS hardware average | 2134.1 MHz | 2585.4 MHz | +451.3 MHz |
| board power average | 410.1 W | 412.4 W | +2.3 W |
| average FPS | 10.4451 | 10.5113 | +0.634% |
| minimum FPS | 9.6148 | 9.5332 | -0.849% |
| maximum FPS | 11.9415 | 11.9794 | +0.317% |

No Xid, reset-required event, or residual offset was observed. This is a clean
counterexample to the claim that +450 MHz SYS is intrinsically unstable on the
tested state. It does not prove stability in other workloads or temperatures.

## Evidence boundary

Confirmed:

- SYS has an independently writable domain offset on this driver/GPU/VBIOS;
- GET_CONTROL retains the exact requests;
- the private hardware counter measures the resulting SYS frequency;
- +300 MHz materially changes SYS during the 6K Cyberpunk benchmark while GPC
  and XBAR do not rise;
- the ratio-preserving +450 MHz run changes measured SYS by +451.3 MHz and
  completes the benchmark;
- +600 MHz combinations fail on the Cyberpunk startup path while some FurMark
  runs survive.

Not confirmed:

- the exact GB202 hardware consumer that causes the +600 MHz failure;
- a precise long-run performance gain from the short A/B runs;
- a universal stability boundary;
- that a logical clock-domain voltage offset wins final physical MSVDD
  arbitration in every workload.
