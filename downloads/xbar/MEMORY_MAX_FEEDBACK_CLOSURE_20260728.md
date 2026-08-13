# GB202 finite DRAM-MAX feedback closure (2026-07-28)

## Outcome

The Cyberpunk 2077 Path Tracing regression is caused by the maximum side of
the NVIDIA memory locked-clock request, not by the minimum record, the actual
memory frequency, the V/F curve, or the board power ceiling.

The shortest controlled comparison is:

```text
0x78 DRAM MIN only = 15000000 kHz
0x75 DRAM MAX only = 15000000 kHz
```

Both runs reported an actual memory clock of approximately 15001 MHz.  Only
the MAX record collapsed the rail-1/XBAR state and triggered the performance
regression.

## Scene-window measurements

All four runs used Cyberpunk 2077 2.31, 6144x3456, Path Tracing, the same
127-point GPU V/F curve, the same +2000 memory offset, and a 600 W requested
and enforced board limit.

| Request | Avg FPS | GPU MHz | 1 s board W | Actual MCLK MHz | XBAR MHz | SYS MHz | Observed branch-1 voltage | Branch-1 workload | Branch-1 estimated power |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| MIN-only 15000 | 11.7864 | 2893.7 | 560.6 | 15001 | 2356.0 | 2332.4 | 967.2 mV | 257.3 | 188.2 W |
| MAX-only 14000 | 9.6948 | 2778.8 | 406.7 | 15001 | 1440.0 | 1238.7 | 870.0 mV | 372.3 | 281.1 W |
| MAX-only 15000 | 9.9580 | 2774.7 | 414.2 | 15001 | 1493.6 | 1501.0 | 870.0 mV | 369.2 | 275.1 W |
| MAX-only 16000 | 9.8533 | 2787.1 | 413.7 | 15001 | 1492.7 | 1500.0 | 870.0 mV | 356.5 | 278.4 W |

MAX-only 15000 versus MIN-only 15000 changed:

- average FPS: -15.51%;
- average GPU clock: -4.11%;
- one-second average board power: -26.11%;
- XBAR clock: -36.60%;
- observed branch-1 voltage: -10.05%;
- branch-1 normalized workload: +43.49%;
- branch-1 estimated power: +46.17%.

The 16000 MHz MAX is decisive because it is non-binding: actual memory still
ran at approximately 15001 MHz, yet the bad state was almost identical to the
15000 MHz MAX run.  Therefore the trigger is the presence of a finite DRAM
maximum client/range state.  The 14000 result additionally shows that the
numeric maximum participates in propagation even though telemetry still
reported the same actual memory clock.

## Direct XBAR equivalence test

The missing causal discrimination was whether the low XBAR/rail-1 state was
merely correlated with the finite MCLK maximum.  A second runtime experiment
therefore bypassed the MCLK client and submitted a strict XBAR maximum of
1493 MHz directly.  The comparison used the same FurMark Vulkan 3840x2160
load and 40 direct policy-model samples per state:

| State | Observed branch-1 MHz | Observed branch-1 mV | Branch-1 workload | Candidate branch-1 MHz | Branch-1 estimated power | DG0 target | Loaded GPU MHz | Instant board W |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| No temporary limit | 2129.6 | 888.6 | 325.9 | 2316.4 | 166.6 W | 2379.1 MHz | 2352.6 | 553.9 |
| MCLK MAX 16000 | 1498.2 | 870.0 | 526.2 | 2216.2 | 234.1 W | 3018.9 MHz | 2963.5 | 598.9 |
| XBAR MAX 1493 | 1492.3 | 870.0 | 522.4 | 2218.2 | 233.8 W | 3021.8 MHz | 2963.7 | 600.1 |

The MCLK-MAX and direct-XBAR-MAX states agree on the decisive downstream
variables: approximately 1.49 GHz XBAR, exactly 870 mV on observed branch 1,
approximately 522--526 normalized workload, approximately 234 W estimated
branch-1 power, and approximately 3.02 GHz DG0.  This is not just a similar
benchmark score; it is the same internal controller state to measurement
precision.

This establishes two runtime facts:

1. A finite, non-binding MCLK maximum is sufficient to impose the low
   XBAR/shared-rail state.
2. Imposing that XBAR state directly is sufficient to reproduce the same
   workload-normalization and candidate-estimator state.

The sign of the final performance effect depends on workload composition.  In
the path-traced Cyberpunk run this state reduces the GPC target and leaves
board-power headroom unused.  In FurMark it moves the two-branch model in the
opposite direction and raises the loaded core clock from about 2.35 to
2.96 GHz.  Therefore the defect is not a universal "memory lock lowers
performance" rule.  It is unintended cross-domain controller coupling: a
non-binding MCLK maximum changes XBAR/shared-rail state, after which the same
state-dependent estimator can move the core target either way.

## Closed feedback chain

The R610 runtime fields and the bit-exact R570 model reconstruction together
show the following sequence:

```text
finite DRAM MAX client 0x75
  -> rail-1/XBAR/SYS runtime constraint
  -> actual branch-1 state falls to about 870 mV and 1.44-1.49 GHz
  -> workload generator normalizes observed power by the low actual
     frequency/voltage state
  -> normalized branch-1 workload rises from about 257 to 356-372
  -> candidate evaluator still searches branch 1 near 2.56 GHz and
     1.09-1.11 V
  -> the inflated workload is evaluated at that higher candidate state
  -> branch-1 estimated power rises from about 188 W to 275-281 W
  -> WORKLOAD_COMBINED_2X lowers DG0/GPC target
  -> the board uses only about 407-414 W of the available 600 W
```

The key mismatch is observable directly.  In the MAX-only 15000 run:

```text
actual branch-1 frequency/voltage:    1493.6 MHz / 870.0 mV
candidate branch-1 frequency/voltage: 2553.3 MHz / 1091.2 mV
```

The estimator is not merely reporting physical MSVDD consumption.  It applies
the normalized workload to a candidate state that the downstream clock/rail
propagation does not actually deliver.

## Static clock-topology support

The active clock-propagation topology remains ID 7 with or without the finite
MAX.  Its relation table contains bidirectional type-5 shared-voltage-rail
relationships:

```text
relation 4: MCLK <-> XBAR, voltage rail 1
relation 5: MCLK <-> SYS,  voltage rail 1
```

The public clock-domain control, topology control/status, relationship-info,
VF-info/status/control, PMGR-info and policy-info objects did not change when
the MAX client was added.  Thus this is not a topology switch or a persistent
configuration rewrite; it is a dynamic range/arbitration effect inside the
existing topology.

The exact R610 GSP dispatch descriptor for the set operation is:

```text
command:       0x2080e0af
parameter size: 0x13c08
handler:       0x0165e598
flags:         0x44
```

The request uses inline 0x13c-byte client entries.  For this experiment:

```text
client 0x75 = strict DRAM maximum
client 0x78 = strict DRAM minimum
input type  = 2 (frequency)
domain      = 0x10 (MCLK)
```

The older same-generation RM/MODS implementation supplies the missing
algorithmic shape.  Its type-5 relation code converts both endpoints of a
source frequency range through `FREQ_TO_VOLT`, intersects the resulting
shared-rail voltage range, converts that range through `VOLT_TO_FREQ` for the
target clock domain, and then clamps/quantizes the target range.  When the
source range is a single value it reuses the same converted voltage for both
endpoints.  This exactly explains why merely installing a finite MCLK MAX can
create an XBAR maximum even when physical MCLK never reaches that maximum.

The R610 private function and field names remain unavailable, but the active
R610 topology, the endpoint-conversion algorithm in the same-generation code,
and the direct MCLK-MAX/XBAR-MAX runtime equivalence all point to the same
mechanism.

## Evidence levels

### PROVED

- Client 0x75 alone reproduces the regression; client 0x78 alone does not.
- Actual MCLK is the same in the decisive 15000 MIN/MAX comparison.
- A non-binding 16000 MAX still reproduces the bad state.
- Under the same FurMark load, MCLK MAX 16000 and direct XBAR MAX 1493 produce
  the same approximately 1.49 GHz / 870 mV branch-1 state and nearly identical
  workload, estimated power and DG0 target.
- Directly imposing the low XBAR state is sufficient to reproduce the
  downstream estimator state caused by the MCLK maximum.
- The MAX state forces observed branch 1 to 870 mV and approximately
  1.44-1.49 GHz while the candidate model remains near 2.56 GHz and 1.1 V.
- The workload generator and candidate evaluator equations explain the
  measured workload and estimated-power increase.
- The active topology has MCLK-XBAR and MCLK-SYS bidirectional type-5
  relationships on voltage rail 1.
- No Xid, thermal slowdown, hardware slowdown or power-brake slowdown occurred
  in the controlled runs.

### HIGH-CONFIDENCE INFERENCE

The exact R610 implementation uses the existing type-5 relationship to
convert the finite MCLK maximum into a rail-1 range constraint which caps the
delivered XBAR/SYS voltage/frequency.  The causal input/output behavior is now
proved at runtime and the endpoint-conversion algorithm is present in the
same-generation RM/MODS code, but the corresponding private R610 function and
dynamic range object are not exported by the public status controls used here.

### UNKNOWN

- The exact private R610 field that holds the propagated rail-1 maximum.
- The exact private R610 function that performs the type-5 range conversion.
- Whether NVIDIA considers this cross-domain behavior intentional or a driver/
  firmware defect.
- Whether a later driver changes the propagation or workload-normalization
  ordering.

## Related internal evidence

The local MODS package contains an NVIDIA comment that it disables
`LIMIT_MCLK_LIMIT` because that limit can prevent MODS from correctly locking
dramclk, referencing internal bug 3814423.  Static recovery gives
`LIMIT_MCLK_LIMIT = 251 (0xfb)`.  However, the public 0xfb PERF-limit entry
remained inactive while client 0x75 was present.  This is corroboration that
NVIDIA has encountered an MCLK-limit/locking conflict, not proof that 0xfb is
the direct object responsible for the R610 0x75 behavior.

## Artifacts

```text
MIN-only 15000: benchmark_logs/cp2077_6k_20260728_121854
MAX-only 15000: benchmark_logs/cp2077_6k_20260728_121623
MAX-only 16000: benchmark_logs/cp2077_6k_20260728_123133
MAX-only 14000: benchmark_logs/cp2077_6k_20260728_123452
clock-state A/B: dram_max_state_diff_20260728
FurMark baseline: benchmark_logs/furmark_vk_3840x2160_20260728_221823
FurMark MCLK MAX 16000: benchmark_logs/furmark_vk_3840x2160_20260728_221722
FurMark XBAR MAX 1493: benchmark_logs/furmark_vk_3840x2160_20260728_221736
```

All temporary 0x75/0x78 and XBAR inputs were cleared by the same control after
each holder exited.  The persistent LACT configuration was not modified by
these isolation runs.  FurMark rendered for the requested interval and then
segfaulted in its timed-exit path; no NVIDIA Xid was logged and the captured
load windows were complete.
