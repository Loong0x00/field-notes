# RTX 5090 Lightning VBIOS MCLK max-only A/B test

Date: 2026-08-03

## Purpose

Determine whether the previously observed MCLK maximum-constraint regression is
specific to the ASUS Astral VBIOS or remains present with the MSI Lightning
VBIOS under the same driver/GSP stack.

## Fixed state

- GPU: RTX 5090, same physical card
- VBIOS: MSI Lightning `98.02.2E.C0.0F`
- Driver/GSP stack: NVIDIA `610.43.03`
- Power limit: 600 W during both benchmark runs
- Memory offset: +2000 MHz; observed MCLK 15001 MHz
- Benchmark: Cyberpunk 2077 2.31, 6144x3456, current 6K path-tracing preset
- Same benchmark scene and fixed 972 rendered frames in each run

The A/B variable was only the private RM DRAM maximum constraint:

- Baseline: no DRAM min/max constraint
- Test: maximum constraint configured and read back as 16000000 kHz

## Results

| Metric | Baseline | MCLK max 16000 | Change |
|---|---:|---:|---:|
| Average FPS | 11.6745 | 10.4508 | -10.48% |
| Minimum FPS | 10.2005 | 9.4909 | -6.96% |
| Maximum FPS | 13.7228 | 12.1464 | -11.49% |
| XBAR average | 2477.5 MHz | 1613.5 MHz | -34.87% |
| SYS average | 2292.1 MHz | 1470.9 MHz | -35.83% |
| GPC average | 2824.8 MHz | 2949.3 MHz | +4.41% |
| GPU voltage average | 996.8 mV | 1024.3 mV | +2.76% |
| Reported power average | 599.6 W | 556.6 W | -7.17% |

The max-only request was accepted by RM and read back before the second run:

```text
dram_limit_set_status=0x00000000 requested_khz=16000000
dram_max_readback_status=0x00000000 valid=1 type=2 configured_khz=16000000 domain=16 effective_khz=16000000
```

## Conclusion

The regression reproduces with the MSI Lightning VBIOS. Therefore it is not an
ASUS Astral VBIOS-specific defect. Together with the previous ASUS result, the
evidence points to behavior shared by the driver/GSP/RM clock-policy path (or a
common VBIOS-independent firmware policy), not to one board VBIOS image.

This A/B does not by itself separate host RM code from GSP firmware. That would
require changing the driver/GSP version while keeping this VBIOS and workload
fixed.

## Artifacts

- Baseline: `benchmark_logs/cp2077_6k-lightning-baseline_20260803_144825/`
- Max-only: `benchmark_logs/cp2077_6k-lightning-max16000_20260803_145235/`
- Constraint holder log:
  `benchmark_logs/lightning_mclk_max16000_holder_20260803_145235.log`

## Restoration

After the test:

- the DRAM clock constraint was cleared;
- `/etc/lact/config.yaml` was restored byte-for-byte from its pre-test backup;
- `lactd` was restarted and verified active;
- the runtime memory clock returned to 14001 MHz;
- the board power limit was restored to 800 W.
